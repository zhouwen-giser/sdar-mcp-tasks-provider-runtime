import { randomUUID } from "node:crypto";
import { protoStructToJson } from "../../adapter-protocol/src/index.js";
import type { GrpcAdapterGateway } from "../../adapter-protocol/src/index.js";
import type { Clock } from "../../domain/src/index.js";
import { isTerminalState, mapAdapterSnapshot, systemClock } from "../../domain/src/index.js";
import type { PendingCommandRecord, TaskRepository } from "../../persistence-postgres/src/index.js";

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
        const ack = await this.gateway.requestCancel(
          task.taskId,
          task.operationName,
          task.argumentHash,
          command.stopReason === "DEADLINE_REACHED" ? "DEADLINE_REACHED" : "USER_REQUESTED",
          command.commandSequence,
          {
            authorizationContextHash: task.authorizationContextHash,
            executionMode: task.executionMode,
            simulationId: task.simulationId,
          },
        );
        if (Number(ack.commandSequence) !== command.commandSequence) {
          await this.retry(command, "COMMAND_SEQUENCE_MISMATCH", "Adapter Ack sequence mismatch.");
          result.retried += 1;
          continue;
        }
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
          task.operationName,
          task.argumentHash,
          {
            authorizationContextHash: task.authorizationContextHash,
            executionMode: task.executionMode,
            simulationId: task.simulationId,
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
        await this.repository.rejectUserCancel(
          command,
          Number(snapshot.revision),
          mapAdapterSnapshot({
            state: snapshot.state,
            reasonCode: snapshot.reasonCode,
            message: snapshot.message,
            retryable: snapshot.retryable,
            result: protoStructToJson(snapshot.result),
          }),
          ack as unknown as Record<string, unknown>,
        );
        result.rejected += 1;
      } catch (error) {
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
