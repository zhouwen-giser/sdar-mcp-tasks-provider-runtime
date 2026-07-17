import { createHash, randomUUID } from "node:crypto";
import {
  validateAdapterSnapshotIdentity,
  validateCommandAckIdentity,
} from "../../adapter-protocol/src/index.js";
import type { GrpcAdapterGateway } from "../../adapter-protocol/src/index.js";
import type { Clock, ExecutionMode } from "../../domain/src/index.js";
import { isTerminalState, systemClock } from "../../domain/src/index.js";
import { OperationSnapshotRepository } from "../../persistence-postgres/src/index.js";
import type { PendingCommandRecord, TaskRepository } from "../../persistence-postgres/src/index.js";
import { validatedSnapshotTransition } from "./result-contract.js";
import type { ValidatedOperation } from "../../operation-registry/src/index.js";

export interface CommandDispatcherTickResult {
  claimed: number;
  acknowledged: number;
  retried: number;
  rejected: number;
  exhausted: number;
  terminal: number;
}

export class DurableCommandDispatcher {
  readonly workerId: string;

  constructor(
    readonly gateway: GrpcAdapterGateway,
    readonly repository: TaskRepository,
    readonly clock: Clock = systemClock,
    workerId: string = randomUUID(),
    readonly maxSafeStopAttempts = 5,
    readonly claimLeaseMs = 30_000,
    readonly operationSnapshots: OperationSnapshotRepository = new OperationSnapshotRepository(
      repository.pool,
    ),
  ) {
    this.workerId = workerId;
  }

  async tick(): Promise<CommandDispatcherTickResult> {
    const now = this.clock.now();
    const commands = await this.repository.claimDueCommands(now, this.workerId, this.claimLeaseMs);
    const result: CommandDispatcherTickResult = {
      claimed: commands.length,
      acknowledged: 0,
      retried: 0,
      rejected: 0,
      exhausted: 0,
      terminal: 0,
    };
    for (const command of commands) {
      const task = await this.repository.getById(command.taskId);
      if (task === null || isTerminalState(task.internalState)) {
        await this.repository.rejectClaimedCommand(
          command,
          "TASK_TERMINAL",
          "Task transitioned to terminal while command was in progress.",
        );
        result.terminal += 1;
        continue;
      }
      try {
        const operation = (
          await this.operationSnapshots.loadOperationSnapshot(task.operationSnapshotId)
        ).operation;
        if (command.commandType === "CANCEL") {
          await this.repository.supersedeExpiredClaimedNormalCommandsForSafeStop(command.taskId);
          const outcome = await this.dispatchCancel(command, task, operation);
          if (outcome === "acknowledged") result.acknowledged += 1;
          else if (outcome === "retriable") result.retried += 1;
          else if (outcome === "rejected") result.rejected += 1;
          else result.exhausted += 1;
          continue;
        }
        if (command.commandType === "UPDATE") {
          const outcome = await this.dispatchUpdate(command, task, operation.name);
          if (outcome === "acknowledged") {
            result.acknowledged += 1;
          } else if (outcome === "retriable") {
            result.retried += 1;
          } else {
            result.rejected += 1;
          }
          continue;
        }
        const outcome = await this.dispatchPauseOrResume(
          command,
          task,
          operation.name,
          command.commandType,
        );
        if (outcome === "acknowledged") {
          result.acknowledged += 1;
        } else if (outcome === "retriable") {
          result.retried += 1;
        } else {
          result.rejected += 1;
        }
      } catch (error) {
        if (isIdentityError(error)) {
          await this.repository.recordIdentityConflict(
            command.taskId,
            error instanceof Error ? error.message : "ADAPTER_IDENTITY_MISMATCH",
          );
        }
        if (
          command.commandType === "CANCEL" &&
          command.stopReason !== "USER_REQUESTED" &&
          command.attemptCount >= this.maxSafeStopAttempts
        ) {
          await this.repository.failSafeStopUnconfirmed(
            command,
            error instanceof Error ? error.message : "Safe stop could not be confirmed.",
          );
          result.exhausted += 1;
          continue;
        }
        if (
          command.commandType !== "CANCEL" &&
          (task.cancelRequested || task.stopReason !== null)
        ) {
          await this.repository.supersedeNormalCommandsForSafeStop(command.taskId, true);
          result.exhausted += 1;
          continue;
        }
        await this.repository.retryClaimedCommand(
          command,
          new Date(this.clock.now().getTime() + retryDelayMs(command)),
          "ADAPTER_TRANSIENT_ERROR",
          error instanceof Error ? error.message : "Adapter command failed.",
        );
        result.retried += 1;
      }
    }
    return result;
  }

  private async dispatchCancel(
    command: PendingCommandRecord,
    task: {
      taskId: string;
      operationName: string;
      argumentHash: string;
      externalExecutionId: string | null;
      authorizationContextHash: string;
      executionMode: ExecutionMode;
      simulationId: string | null;
    },
    operation: ValidatedOperation,
  ): Promise<"acknowledged" | "retriable" | "rejected" | "exhausted"> {
    const operationName = operation.name;
    const stopReason =
      command.stopReason === "DEADLINE_REACHED"
        ? "DEADLINE_REACHED"
        : command.stopReason === "START_WINDOW_MISSED"
          ? "START_WINDOW_MISSED"
          : "USER_REQUESTED";
    const ack = await this.gateway.requestCancel(
      task.taskId,
      operationName,
      task.argumentHash,
      stopReason,
      command.commandSequence,
      {
        ...executionOptions(task),
        externalExecutionId: task.externalExecutionId,
      },
    );
    validateCommandAckIdentity(ack, {
      taskId: task.taskId,
      externalExecutionId: task.externalExecutionId,
      operationName,
      argumentHash: task.argumentHash,
      authorizationContextHash: task.authorizationContextHash,
      executionMode: task.executionMode,
      simulationId: task.simulationId,
      commandSequence: command.commandSequence,
    });
    if (ack.accepted) {
      await this.repository.acknowledgeClaimedCommand(
        command,
        ack as unknown as Record<string, unknown>,
      );
      return "acknowledged";
    }
    if (isRetryableAck(ack.reasonCode)) {
      await this.retry(
        command,
        ack.reasonCode || "ADAPTER_RETRYABLE_REJECTION",
        ack.message || "Adapter retryable safe-stop rejection.",
      );
      return "retriable";
    }
    if (command.stopReason !== "USER_REQUESTED") {
      await this.repository.failSafeStopUnconfirmed(
        command,
        ack.message || "Adapter permanently rejected the required safe stop.",
      );
      return "exhausted";
    }
    const reconciled = await this.gateway.reconcileExecution(
      task.taskId,
      operationName,
      task.argumentHash,
      {
        authorizationContextHash: task.authorizationContextHash,
        executionMode: task.executionMode,
        simulationId: task.simulationId,
        externalExecutionId: task.externalExecutionId,
      },
    );
    if (reconciled.status !== "FOUND" || reconciled.snapshot === undefined) {
      await this.retry(
        command,
        reconciled.reasonCode || "RECONCILE_UNAVAILABLE",
        reconciled.message || "Unable to reconcile rejected cancellation.",
      );
      return "retriable";
    }
    const snapshot = reconciled.snapshot;
    if (reconciled.externalExecutionId !== snapshot.externalExecutionId) {
      throw new Error("ADAPTER_RECONCILE_IDENTITY_MISMATCH");
    }
    validateAdapterSnapshotIdentity(snapshot, {
      taskId: task.taskId,
      externalExecutionId: task.externalExecutionId,
      operationName,
      argumentHash: task.argumentHash,
      authorizationContextHash: task.authorizationContextHash,
      executionMode: task.executionMode,
      simulationId: task.simulationId,
    });
    await this.repository.rejectUserCancel(
      command,
      Number(snapshot.revision),
      validatedSnapshotTransition(operation, snapshot),
      ack as unknown as Record<string, unknown>,
    );
    return "rejected";
  }

  private async dispatchUpdate(
    command: PendingCommandRecord,
    task: {
      taskId: string;
      operationName: string;
      argumentHash: string;
      externalExecutionId: string | null;
      authorizationContextHash: string;
      executionMode: ExecutionMode;
      simulationId: string | null;
    },
    operationName: string,
  ): Promise<"acknowledged" | "retriable" | "rejected"> {
    const answers = parseUpdateAnswers(command.payload);
    const identity = {
      taskId: task.taskId,
      operationName,
      argumentHash: task.argumentHash,
      commandSequence: command.commandSequence,
    };
    const ack = await this.gateway.updateExecution(identity, answers, {
      ...executionOptions(task),
      externalExecutionId: task.externalExecutionId,
    });
    validateCommandAckIdentity(ack, {
      taskId: task.taskId,
      externalExecutionId: task.externalExecutionId,
      operationName,
      argumentHash: task.argumentHash,
      authorizationContextHash: task.authorizationContextHash,
      executionMode: task.executionMode,
      simulationId: task.simulationId,
      commandSequence: command.commandSequence,
    });
    if (!ack.accepted) {
      if (isRetryableAck(ack.reasonCode)) {
        await this.retry(
          command,
          ack.reasonCode || "ADAPTER_RETRYABLE_REJECTION",
          ack.message || "Adapter rejected update command.",
        );
        return "retriable";
      }
      await this.repository.rejectClaimedCommand(
        command,
        typeof ack.reasonCode === "string" ? ack.reasonCode : "ADAPTER_REJECTED",
        ack.message || "Adapter rejected update command.",
      );
      return "rejected";
    }
    await this.repository.acknowledgeClaimedCommand(
      command,
      ack as unknown as Record<string, unknown>,
    );
    await this.repository.completeInputAnswers(task.taskId, answers);
    return "acknowledged";
  }

  private async dispatchPauseOrResume(
    command: PendingCommandRecord,
    task: {
      taskId: string;
      operationName: string;
      argumentHash: string;
      externalExecutionId: string | null;
      authorizationContextHash: string;
      executionMode: ExecutionMode;
      simulationId: string | null;
    },
    operationName: string,
    commandType: "PAUSE" | "RESUME",
  ): Promise<"acknowledged" | "retriable" | "rejected"> {
    const identity = {
      taskId: task.taskId,
      operationName,
      argumentHash: task.argumentHash,
      commandSequence: command.commandSequence,
    };
    const ack = await (commandType === "PAUSE"
      ? this.gateway.pauseExecution(identity, {
          ...executionOptions(task),
          externalExecutionId: task.externalExecutionId,
        })
      : this.gateway.resumeExecution(identity, {
          ...executionOptions(task),
          externalExecutionId: task.externalExecutionId,
        }));
    validateCommandAckIdentity(ack, {
      taskId: task.taskId,
      externalExecutionId: task.externalExecutionId,
      operationName,
      argumentHash: task.argumentHash,
      authorizationContextHash: task.authorizationContextHash,
      executionMode: task.executionMode,
      simulationId: task.simulationId,
      commandSequence: command.commandSequence,
    });
    if (!ack.accepted) {
      if (isRetryableAck(ack.reasonCode)) {
        await this.retry(
          command,
          ack.reasonCode || "ADAPTER_RETRYABLE_REJECTION",
          ack.message || "Adapter rejected pause/resume command.",
        );
        return "retriable";
      }
      await this.repository.rejectClaimedCommand(
        command,
        typeof ack.reasonCode === "string" ? ack.reasonCode : "ADAPTER_REJECTED",
        ack.message || "Adapter rejected pause or resume command.",
      );
      return "rejected";
    }
    await this.repository.acknowledgeClaimedCommand(
      command,
      ack as unknown as Record<string, unknown>,
    );
    return "acknowledged";
  }

  private async retry(
    command: PendingCommandRecord,
    errorCode: string,
    errorMessage: string,
  ): Promise<void> {
    await this.repository.retryClaimedCommand(
      command,
      new Date(this.clock.now().getTime() + retryDelayMs(command)),
      errorCode,
      errorMessage,
    );
  }
}

function retryDelayMs(command: PendingCommandRecord): number {
  const attempts = Math.max(command.attemptCount - 1, 0);
  return Math.min(30_000, 250 * 2 ** Math.min(attempts, 7));
}

function isRetryableAck(reasonCode: string): boolean {
  return /TRANSIENT|RETRY|UNAVAILABLE|TIMEOUT/.test(reasonCode.toUpperCase());
}

function isIdentityError(error: unknown): boolean {
  return error instanceof Error && error.message.includes("IDENTITY_MISMATCH");
}

function parseUpdateAnswers(payload: Record<string, unknown>) {
  const answers = payload.answers;
  if (
    answers === undefined ||
    answers === null ||
    typeof answers !== "object" ||
    Array.isArray(answers)
  ) {
    throw new Error("INVALID_UPDATE_COMMAND_PAYLOAD");
  }
  const answerRecord = answers as Record<string, unknown>;
  return Object.entries(answerRecord).map(([key, value]) => ({
    key,
    value,
    answerHash: commandHash(canonicalize(value)),
  }));
}

function canonicalize(value: unknown): string {
  if (value === null || typeof value !== "object") return JSON.stringify(value);
  if (Array.isArray(value)) return `[${value.map(canonicalize).join(",")}]`;
  const object = value as Record<string, unknown>;
  return `{${Object.keys(object)
    .sort()
    .map((key) => `${JSON.stringify(key)}:${canonicalize(object[key])}`)
    .join(",")}}`;
}

function commandHash(value: unknown): string {
  return createHash("sha256").update(canonicalize(value)).digest("hex");
}

function executionOptions(task: {
  authorizationContextHash: string;
  executionMode: ExecutionMode;
  simulationId: string | null;
}): Record<string, unknown> {
  return {
    authorizationContextHash: task.authorizationContextHash,
    executionMode: task.executionMode,
    simulationId: task.simulationId,
  };
}
