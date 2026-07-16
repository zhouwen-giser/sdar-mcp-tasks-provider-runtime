import { createHash, randomUUID } from "node:crypto";
import type { GrpcAdapterGateway } from "../../adapter-protocol/src/index.js";
import { protoStructToJson } from "../../adapter-protocol/src/index.js";
import type { ExecutionSnapshot } from "../../adapter-protocol/src/index.js";
import type { AuthorizationContext, TaskRecord } from "../../domain/src/index.js";
import { isTerminalState, mapAdapterSnapshot } from "../../domain/src/index.js";
import type { ValidatedManifest, ValidatedOperation } from "../../operation-registry/src/index.js";
import type { TaskRepository } from "../../persistence-postgres/src/index.js";

export type ToolInvocationResult =
  | { kind: "result"; result: Record<string, unknown> }
  | { kind: "task"; task: Record<string, unknown> };

export class TaskEngine {
  readonly #repository: TaskRepository;

  constructor(
    readonly manifest: ValidatedManifest,
    readonly operationSnapshotIds: Map<string, string>,
    readonly gateway: GrpcAdapterGateway,
    repository: TaskRepository,
  ) {
    this.#repository = repository;
  }

  async callOperation(
    operation: ValidatedOperation,
    argumentsValue: Record<string, unknown>,
    authorization: AuthorizationContext,
    ttlMs?: number,
  ): Promise<ToolInvocationResult> {
    operation.validateArguments(argumentsValue);
    if (operation.execution === "SYNCHRONOUS") {
      const response = await this.gateway.startOperation(operation.name, argumentsValue, {
        authorizationContextHash: authorization.hash,
        executionMode: authorization.executionMode,
        simulationId: authorization.simulationId,
      });
      return { kind: "result", result: resultFromStart(response) };
    }

    const taskId = randomUUID();
    const argumentHash = hashArguments(argumentsValue);
    const operationSnapshotId = this.operationSnapshotIds.get(operation.name);
    if (operationSnapshotId === undefined) throw new Error("OPERATION_SNAPSHOT_NOT_FOUND");
    const intent = {
      taskId,
      providerId: this.manifest.providerId,
      operationName: operation.name,
      operationSnapshotId,
      authorization,
      arguments: argumentsValue,
      argumentHash,
    };
    await this.#repository.createAdmissionIntent(intent);

    let response;
    try {
      response = await this.gateway.startOperation(operation.name, argumentsValue, {
        taskId,
        argumentHash,
        authorizationContextHash: authorization.hash,
        executionMode: authorization.executionMode,
        simulationId: authorization.simulationId,
        invocationAttempt: 1,
      });
    } catch (error) {
      await this.#repository.markAdmissionUncertain(taskId);
      throw error;
    }
    if (response.result === "rejected" || response.rejected !== undefined) {
      const rejected = rejectionResult(response.rejected);
      await this.#repository.recordRejection(taskId, rejected);
      return { kind: "result", result: rejected };
    }
    const accepted = response.accepted;
    if (accepted === undefined) {
      await this.#repository.markAdmissionUncertain(taskId);
      throw new Error("ADAPTER_START_RESPONSE_MISSING_RESULT");
    }
    const snapshot = normalizeSnapshot(accepted.initialSnapshot);
    const transition = mapAdapterSnapshot(snapshot);
    if (operation.execution === "TASK_CAPABLE" && transition.terminal) {
      const result = transition.result ?? transition.error ?? {};
      await this.#repository.completeAdmissionWithoutTask(
        taskId,
        response as unknown as Record<string, unknown>,
      );
      return { kind: "result", result };
    }
    let task;
    try {
      task = await this.#repository.publishAccepted({
        ...intent,
        externalExecutionId: accepted.externalExecutionId,
        transition,
        adapterRevision: Number(accepted.initialSnapshot.revision),
        ttlMs: ttlMs ?? 259_200_000,
        adapterResponse: response as unknown as Record<string, unknown>,
      });
    } catch (error) {
      await this.#repository.markAdmissionUncertain(taskId);
      throw error;
    }
    return { kind: "task", task: detailedTask(task) };
  }

  async getTask(
    taskId: string,
    authorization: AuthorizationContext,
  ): Promise<Record<string, unknown>> {
    let task = await this.#repository.getAuthorized(taskId, authorization);
    if (!isTerminalState(task.internalState)) {
      const snapshot = await this.gateway.getExecution(task.taskId, task.externalExecutionId);
      task = await this.#repository.applySnapshot(
        task.taskId,
        Number(snapshot.revision),
        mapAdapterSnapshot(normalizeSnapshot(snapshot)),
      );
    }
    return detailedTask(task);
  }
}

function normalizeSnapshot(snapshot: ExecutionSnapshot) {
  return {
    state: snapshot.state,
    reasonCode: snapshot.reasonCode,
    message: snapshot.message,
    retryable: snapshot.retryable,
    result: protoStructToJson(snapshot.result),
  };
}

function resultFromStart(
  response: Awaited<ReturnType<GrpcAdapterGateway["startOperation"]>>,
): Record<string, unknown> {
  if (response.rejected !== undefined) return rejectionResult(response.rejected);
  const snapshot = response.accepted?.initialSnapshot;
  if (snapshot === undefined) throw new Error("ADAPTER_START_RESPONSE_MISSING_RESULT");
  const transition = mapAdapterSnapshot(normalizeSnapshot(snapshot));
  if (!transition.terminal) throw new Error("SYNCHRONOUS_OPERATION_RETURNED_NONTERMINAL");
  return transition.result ?? transition.error ?? {};
}

function rejectionResult(
  rejected: { reasonCode: string; message: string; retryable: boolean } | undefined,
) {
  return {
    content: [{ type: "text", text: rejected?.message ?? "Operation rejected." }],
    isError: true,
    structuredContent: {
      outcome: "admission_rejected",
      reasonCode: rejected?.reasonCode ?? "ADMISSION_REJECTED",
      retryable: rejected?.retryable ?? false,
      completedAt: new Date().toISOString(),
    },
  };
}

function hashArguments(value: Record<string, unknown>): string {
  return createHash("sha256")
    .update(JSON.stringify(value, Object.keys(value).sort()))
    .digest("hex");
}

function detailedTask(task: TaskRecord): Record<string, unknown> {
  return {
    taskId: task.taskId,
    status: task.mcpStatus,
    statusMessage: task.statusMessage ?? undefined,
    createdAt: task.createdAt.toISOString(),
    lastUpdatedAt: task.updatedAt.toISOString(),
    ttl: task.ttlMs,
    pollInterval: task.pollIntervalMs,
    ...(task.result === null ? {} : { result: task.result }),
    ...(task.error === null ? {} : { error: task.error }),
    _meta: {
      "io.sdar/taskExecution": {
        profileVersion: "1.0",
        substate: task.substate,
        observationRevision: task.adapterRevision,
        executionMode: task.executionMode,
      },
    },
  };
}
