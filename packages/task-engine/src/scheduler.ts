import { randomUUID } from "node:crypto";
import { protoStructToJson } from "../../adapter-protocol/src/index.js";
import type { GrpcAdapterGateway } from "../../adapter-protocol/src/index.js";
import type { Clock, TaskExecutionTiming } from "../../domain/src/index.js";
import { mapAdapterSnapshot, systemClock } from "../../domain/src/index.js";
import type { ValidatedManifest } from "../../operation-registry/src/index.js";
import type { TaskRepository } from "../../persistence-postgres/src/index.js";

export interface SchedulerTickResult {
  started: number;
  missed: number;
  deferred: number;
  deadlineStops: number;
}

export class DurableScheduler {
  readonly workerId: string;

  constructor(
    readonly manifest: ValidatedManifest,
    readonly gateway: GrpcAdapterGateway,
    readonly repository: TaskRepository,
    readonly clock: Clock = systemClock,
    workerId: string = randomUUID(),
  ) {
    this.workerId = workerId;
  }

  async tick(): Promise<SchedulerTickResult> {
    const now = this.clock.now();
    const result: SchedulerTickResult = { started: 0, missed: 0, deferred: 0, deadlineStops: 0 };
    const due = await this.repository.claimDueScheduled(now, this.workerId);
    for (const task of due) {
      if (task.latestStartAt !== null && now > task.latestStartAt) {
        await this.repository.completeStartWindowMissed(task.taskId, now);
        result.missed += 1;
        continue;
      }
      const operation = this.manifest.operations.find(
        (candidate) => candidate.name === task.operationName,
      );
      if (operation === undefined) {
        await this.repository.releaseScheduleClaim(task.taskId, "Operation snapshot unavailable.");
        result.deferred += 1;
        continue;
      }
      try {
        const response = await this.gateway.startOperation(task.operationName, task.arguments, {
          taskId: task.taskId,
          argumentHash: task.argumentHash,
          authorizationContextHash: task.authorizationContextHash,
          executionMode: task.executionMode,
          simulationId: task.simulationId,
          invocationAttempt: 1,
          timing: adapterTiming(task.timing as unknown as TaskExecutionTiming),
        });
        if (response.rejected !== undefined || response.result === "rejected") {
          await this.repository.completeScheduledRejection(
            task.taskId,
            now,
            response.rejected?.reasonCode ?? "ADMISSION_REJECTED",
            response.rejected?.message ?? "Scheduled execution was rejected.",
            response.rejected?.retryable ?? false,
          );
          result.missed += 1;
          continue;
        }
        const accepted = response.accepted;
        if (accepted === undefined) throw new Error("ADAPTER_START_RESPONSE_MISSING_RESULT");
        const snapshot = accepted.initialSnapshot;
        await this.repository.acceptScheduled(
          task.taskId,
          accepted.externalExecutionId,
          Number(snapshot.revision),
          mapAdapterSnapshot({
            state: snapshot.state,
            reasonCode: snapshot.reasonCode,
            message: snapshot.message,
            retryable: snapshot.retryable,
            result: protoStructToJson(snapshot.result),
          }),
          response as unknown as Record<string, unknown>,
        );
        result.started += 1;
      } catch (error) {
        await this.repository.releaseScheduleClaim(
          task.taskId,
          error instanceof Error ? error.message : "Scheduled start deferred.",
        );
        result.deferred += 1;
      }
    }

    const expired = await this.repository.claimExpiredDeadlines(now);
    for (const task of expired) {
      const ack = await this.gateway.requestCancel(
        task.taskId,
        task.operationName,
        task.argumentHash,
        "DEADLINE_REACHED",
        task.version + 1,
        {
          authorizationContextHash: task.authorizationContextHash,
          executionMode: task.executionMode,
          simulationId: task.simulationId,
        },
      );
      if (ack.accepted) result.deadlineStops += 1;
    }
    return result;
  }
}

function adapterTiming(timing: TaskExecutionTiming): Record<string, unknown> {
  const start =
    timing.start.mode === "scheduled"
      ? {
          mode: "SCHEDULED",
          scheduledAt: timestamp(new Date(timing.start.scheduledAt)),
          startToleranceMs: String(timing.start.startToleranceMs),
        }
      : {
          mode: "IMMEDIATE",
          startToleranceMs: String(timing.start.startToleranceMs),
        };
  return {
    start,
    ...(timing.maxElapsedMs === null ? {} : { maxElapsedMs: String(timing.maxElapsedMs) }),
  };
}

function timestamp(value: Date): { seconds: string; nanos: number } {
  return { seconds: String(Math.floor(value.getTime() / 1000)), nanos: 0 };
}
