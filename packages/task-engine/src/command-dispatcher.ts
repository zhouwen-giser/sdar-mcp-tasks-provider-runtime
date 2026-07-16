import { randomUUID } from "node:crypto";
import {
  validateAdapterSnapshotIdentity,
  validateCommandAckIdentity,
} from "../../adapter-protocol/src/index.js";
import type { GrpcAdapterGateway } from "../../adapter-protocol/src/index.js";
import type { Clock } from "../../domain/src/index.js";
import { isTerminalState, systemClock } from "../../domain/src/index.js";
import { OperationSnapshotRepository } from "../../persistence-postgres/src/index.js";
import type { PendingCommandRecord, TaskRepository } from "../../persistence-postgres/src/index.js";
import { validatedSnapshotTransition } from "./result-contract.js";

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
    readonly operationSnapshots: OperationSnapshotRepository = new OperationSnapshotRepository(
      repository.pool,
    ),
  ) {
    this.workerId = workerId;
  }

  async tick(): Promise<CommandDispatcherTickResult> {
    const now = this.clock.now();
    const commands = await this.repository.claimDueCancelCommands(now, this.workerId);
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
        await this.repository.failSafeStopUnconfirmed(
          command,
          "Stop command closed because the Task was already terminal.",
        );
        result.terminal += 1;
        continue;
      }
      try {
        const operation = (
          await this.operationSnapshots.loadOperationSnapshot(task.operationSnapshotId)
        ).operation;
        if (!operation.capabilities.cancel) throw new Error("CANCEL_NOT_SUPPORTED");
        const ack = await this.gateway.requestCancel(
          task.taskId,
          operation.name,
          task.argumentHash,
          command.stopReason === "DEADLINE_REACHED"
            ? "DEADLINE_REACHED"
            : command.stopReason === "START_WINDOW_MISSED"
              ? "START_WINDOW_MISSED"
              : "USER_REQUESTED",
          command.commandSequence,
          {
            authorizationContextHash: task.authorizationContextHash,
            executionMode: task.executionMode,
            simulationId: task.simulationId,
            externalExecutionId: task.externalExecutionId,
          },
        );
        validateCommandAckIdentity(ack, {
          taskId: task.taskId,
          externalExecutionId: task.externalExecutionId,
          operationName: operation.name,
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
          result.acknowledged += 1;
          continue;
        }
        if (isRetryableAck(ack.reasonCode)) {
          await this.retry(command, ack.reasonCode || "ADAPTER_RETRYABLE_REJECTION", ack.message);
          result.retried += 1;
          continue;
        }
        if (command.stopReason !== "USER_REQUESTED") {
          await this.repository.failSafeStopUnconfirmed(
            command,
            ack.message || "Adapter permanently rejected the required safe stop.",
          );
          result.exhausted += 1;
          continue;
        }
        const reconciled = await this.gateway.reconcileExecution(
          task.taskId,
          operation.name,
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
          result.retried += 1;
          continue;
        }
        const snapshot = reconciled.snapshot;
        if (reconciled.externalExecutionId !== snapshot.externalExecutionId) {
          throw new Error("ADAPTER_RECONCILE_IDENTITY_MISMATCH");
        }
        validateAdapterSnapshotIdentity(snapshot, {
          taskId: task.taskId,
          externalExecutionId: task.externalExecutionId,
          operationName: operation.name,
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
        result.rejected += 1;
      } catch (error) {
        if (isIdentityError(error)) {
          await this.repository.recordIdentityConflict(
            task.taskId,
            error instanceof Error ? error.message : "ADAPTER_IDENTITY_MISMATCH",
          );
        }
        if (
          command.stopReason !== "USER_REQUESTED" &&
          command.attemptCount >= this.maxSafeStopAttempts
        ) {
          await this.repository.failSafeStopUnconfirmed(
            command,
            error instanceof Error ? error.message : "Safe stop could not be confirmed.",
          );
          result.exhausted += 1;
        } else {
          await this.retry(
            command,
            "ADAPTER_TRANSIENT_ERROR",
            error instanceof Error ? error.message : "Adapter command failed.",
          );
          result.retried += 1;
        }
      }
    }
    return result;
  }

  private async retry(
    command: PendingCommandRecord,
    errorCode: string,
    errorMessage: string,
  ): Promise<void> {
    const delay = Math.min(30_000, 250 * 2 ** Math.min(command.attemptCount - 1, 7));
    await this.repository.retryClaimedCommand(
      command,
      new Date(this.clock.now().getTime() + delay),
      errorCode,
      errorMessage,
    );
  }
}

function isRetryableAck(reasonCode: string): boolean {
  return /TRANSIENT|RETRY|UNAVAILABLE|TIMEOUT/.test(reasonCode.toUpperCase());
}

function isIdentityError(error: unknown): boolean {
  return error instanceof Error && error.message.includes("IDENTITY_MISMATCH");
}
