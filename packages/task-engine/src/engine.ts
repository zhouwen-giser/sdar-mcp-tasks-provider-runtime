import { createHash, randomUUID } from "node:crypto";
import { Ajv2020 } from "ajv/dist/2020.js";
import type { GrpcAdapterGateway } from "../../adapter-protocol/src/index.js";
import { protoStructToJson } from "../../adapter-protocol/src/index.js";
import type {
  AvailabilityCheckInput,
  ExecutionSnapshot,
} from "../../adapter-protocol/src/index.js";
import type { AuthorizationContext, TaskRecord } from "../../domain/src/index.js";
import type {
  AvailabilityCheck,
  AvailabilityResponseValue,
  Clock,
  TaskExecutionTiming,
  TimingAnchors,
} from "../../domain/src/index.js";
import {
  defaultTiming,
  isTerminalState,
  mapAdapterSnapshot,
  systemClock,
  unknownAvailability,
  validateAvailabilityResponse,
  validateTiming,
} from "../../domain/src/index.js";
import type { ValidatedManifest, ValidatedOperation } from "../../operation-registry/src/index.js";
import type {
  AdmissionIntentRecord,
  IdempotencyRepository,
  PendingCommandRecord,
  StoredInvocation,
  TaskRepository,
} from "../../persistence-postgres/src/index.js";

export type ToolInvocationResult =
  | { kind: "result"; result: Record<string, unknown> }
  | { kind: "task"; task: Record<string, unknown> };

export interface TaskEngineMetrics {
  increment(name: string, labels?: Record<string, string>, amount?: number): void;
}

export interface TaskTraceEvent {
  event: string;
  providerId: string;
  taskId: string;
  operationName: string;
  resourceRef: string | null;
  executionMode: string;
  correlationId: string | null;
}

export class TaskEngine {
  readonly #repository: TaskRepository;

  constructor(
    readonly manifest: ValidatedManifest,
    readonly operationSnapshotIds: Map<string, string>,
    readonly gateway: GrpcAdapterGateway,
    repository: TaskRepository,
    readonly idempotency?: IdempotencyRepository,
    readonly clock: Clock = systemClock,
    readonly metrics?: TaskEngineMetrics,
    readonly onTrace?: (event: TaskTraceEvent) => void,
  ) {
    this.#repository = repository;
  }

  async callOperation(
    operation: ValidatedOperation,
    argumentsValue: Record<string, unknown>,
    authorization: AuthorizationContext,
    ttlMs?: number,
    idempotencyKey?: string,
    timing: TaskExecutionTiming = defaultTiming,
  ): Promise<ToolInvocationResult> {
    const startedAt = performance.now();
    try {
      operation.validateArguments(argumentsValue);
      const anchors = validateTiming(timing, operation.capabilities, this.clock.now());
      const argumentHash = hashArguments(argumentsValue);
      if (idempotencyKey !== undefined) {
        if (!operation.capabilities.idempotency || this.idempotency === undefined) {
          throw new Error("IDEMPOTENCY_NOT_SUPPORTED");
        }
        if (idempotencyKey.length < 1 || idempotencyKey.length > 256) {
          throw new Error("INVALID_IDEMPOTENCY_KEY");
        }
        const outcome = await this.idempotency.execute(
          { authorization, operationName: operation.name, idempotencyKey, argumentHash },
          async (stableTaskId, recovering) =>
            storedInvocation(
              await this.#executeOperation(
                operation,
                argumentsValue,
                authorization,
                ttlMs,
                stableTaskId,
                recovering,
                argumentHash,
                timing,
                anchors,
              ),
            ),
        );
        return await this.#restoreStored(outcome, authorization);
      }
      return await this.#executeOperation(
        operation,
        argumentsValue,
        authorization,
        ttlMs,
        randomUUID(),
        false,
        argumentHash,
        timing,
        anchors,
      );
    } finally {
      const labels = { operation: operation.name, executionMode: authorization.executionMode };
      this.metrics?.increment("sdar_tool_calls_total", labels);
      this.metrics?.increment("sdar_tool_call_duration_seconds_count", labels);
      this.metrics?.increment(
        "sdar_tool_call_duration_seconds_sum",
        labels,
        (performance.now() - startedAt) / 1_000,
      );
    }
  }

  async checkAvailability(
    checks: AvailabilityCheck[],
    authorization: AuthorizationContext,
  ): Promise<AvailabilityResponseValue> {
    if (checks.length < 1 || checks.length > 128) throw new Error("INVALID_AVAILABILITY_BATCH");
    const requestIds = new Set<string>();
    for (const check of checks) {
      if (!check.requestId || requestIds.has(check.requestId)) {
        throw new Error("INVALID_AVAILABILITY_REQUEST_ID");
      }
      requestIds.add(check.requestId);
      const operation = this.manifest.operations.find(
        (candidate) => candidate.name === check.operationName,
      );
      if (!operation?.capabilities.availability) {
        throw new Error("AVAILABILITY_NOT_SUPPORTED");
      }
      if (!isUnresolvedArguments(check.arguments)) operation.validateArguments(check.arguments);
    }
    try {
      const response = await this.gateway.checkAvailability(
        checks.map(toAdapterAvailabilityCheck),
        executionOptions(authorization),
      );
      const checkedAt = protoTimestampToDate(response.checkedAt);
      const results = response.checks.map(fromAdapterAvailability);
      return validateAvailabilityResponse(checkedAt, checks, results);
    } catch (error) {
      if (isAvailabilityContractError(error)) throw error;
      return unknownAvailability(checks);
    }
  }

  async #executeOperation(
    operation: ValidatedOperation,
    argumentsValue: Record<string, unknown>,
    authorization: AuthorizationContext,
    ttlMs: number | undefined,
    taskId: string,
    recovering: boolean,
    argumentHash: string,
    timing: TaskExecutionTiming,
    anchors: TimingAnchors,
  ): Promise<ToolInvocationResult> {
    this.onTrace?.({
      event: "operation.admission",
      providerId: this.manifest.providerId,
      taskId,
      operationName: operation.name,
      resourceRef: resourceReference(operation, argumentsValue),
      executionMode: authorization.executionMode,
      correlationId: authorization.correlationId ?? null,
    });
    if (operation.execution === "SYNCHRONOUS") {
      const response = await this.gateway.startOperation(operation.name, argumentsValue, {
        ...executionOptions(authorization),
        taskId,
        argumentHash,
        timing: toAdapterTiming(timing),
      });
      return { kind: "result", result: resultFromStart(response) };
    }

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
      acceptedAt: anchors.acceptedAt,
      notBefore: anchors.notBefore,
      latestStartAt: anchors.latestStartAt,
      deadlineAt: anchors.deadlineAt,
      ttlMs: ttlMs ?? 259_200_000,
      timing,
    };
    const inserted = await this.#repository.createAdmissionIntent(intent);
    if (!inserted || recovering) {
      const existing = await this.#repository.getById(taskId);
      if (existing !== null) return { kind: "task", task: detailedTask(existing) };
      const reconciliation = await this.gateway.reconcileExecution(
        taskId,
        operation.name,
        argumentHash,
        executionOptions(authorization),
      );
      if (reconciliation.status === "CONFLICT") throw new Error("ADAPTER_RECONCILE_CONFLICT");
      if (reconciliation.status === "FOUND" && reconciliation.snapshot !== undefined) {
        return this.#publishReconciled(
          operation,
          intent,
          reconciliation.externalExecutionId || reconciliation.snapshot.externalExecutionId,
          reconciliation.snapshot,
          ttlMs,
          reconciliation as unknown as Record<string, unknown>,
          timing,
          anchors,
        );
      }
      if (reconciliation.status !== "NOT_FOUND") {
        throw new Error("ADAPTER_RECONCILE_UNAVAILABLE");
      }
    }

    if (timing.start.mode === "scheduled") {
      const task = await this.#repository.publishScheduled({
        ...intent,
        acceptedAt: anchors.acceptedAt,
        notBefore: anchors.notBefore,
        latestStartAt: anchors.latestStartAt,
        deadlineAt: anchors.deadlineAt,
        ttlMs: ttlMs ?? 259_200_000,
        timing,
      });
      return { kind: "task", task: detailedTask(task) };
    }

    let response;
    try {
      response = await this.gateway.startOperation(operation.name, argumentsValue, {
        taskId,
        argumentHash,
        ...executionOptions(authorization),
        invocationAttempt: 1,
        timing: toAdapterTiming(timing),
      });
    } catch (error) {
      await this.#repository.markAdmissionUncertain(taskId);
      throw error;
    }
    if (response.result === "rejected" || response.rejected !== undefined) {
      const rejected =
        this.clock.now() > anchors.latestStartAt
          ? startWindowMissed(this.clock.now(), "Start response arrived after the start window.")
          : rejectionResult(response.rejected);
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
    const inputRequests = normalizeInputRequests(accepted.initialSnapshot);
    const respondedAt = this.clock.now();
    const actualStartedAt = snapshotHasStarted(accepted.initialSnapshot.state) ? respondedAt : null;
    const startWindowMissedAt =
      (actualStartedAt ?? respondedAt) > anchors.latestStartAt ? respondedAt : undefined;
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
        acceptedAt: anchors.acceptedAt,
        notBefore: anchors.notBefore,
        latestStartAt: anchors.latestStartAt,
        deadlineAt: anchors.deadlineAt,
        timing,
        inputRequests,
        actualStartedAt,
        ...(startWindowMissedAt === undefined ? {} : { startWindowMissedAt }),
      });
    } catch (error) {
      await this.#repository.markAdmissionUncertain(taskId);
      throw error;
    }
    return { kind: "task", task: detailedTask(task, inputRequests) };
  }

  async #publishReconciled(
    operation: ValidatedOperation,
    intent: {
      taskId: string;
      providerId: string;
      operationName: string;
      operationSnapshotId: string;
      authorization: AuthorizationContext;
      arguments: Record<string, unknown>;
      argumentHash: string;
      acceptedAt: Date;
      notBefore: Date;
      latestStartAt: Date;
      deadlineAt: Date | null;
      ttlMs: number | null;
      timing: TaskExecutionTiming;
    },
    externalExecutionId: string,
    snapshotValue: ExecutionSnapshot,
    ttlMs: number | undefined,
    adapterResponse: Record<string, unknown>,
    timing: TaskExecutionTiming,
    anchors: TimingAnchors,
  ): Promise<ToolInvocationResult> {
    const transition = mapAdapterSnapshot(normalizeSnapshot(snapshotValue));
    const inputRequests = normalizeInputRequests(snapshotValue);
    const respondedAt = this.clock.now();
    const actualStartedAt = snapshotHasStarted(snapshotValue.state) ? respondedAt : null;
    if (operation.execution === "TASK_CAPABLE" && transition.terminal) {
      await this.#repository.completeAdmissionWithoutTask(intent.taskId, adapterResponse);
      return { kind: "result", result: transition.result ?? transition.error ?? {} };
    }
    const task = await this.#repository.publishAccepted({
      ...intent,
      externalExecutionId,
      transition,
      adapterRevision: Number(snapshotValue.revision),
      ttlMs: ttlMs ?? 259_200_000,
      adapterResponse,
      acceptedAt: anchors.acceptedAt,
      notBefore: anchors.notBefore,
      latestStartAt: anchors.latestStartAt,
      deadlineAt: anchors.deadlineAt,
      timing,
      inputRequests,
      actualStartedAt,
      ...((actualStartedAt ?? respondedAt) > anchors.latestStartAt
        ? { startWindowMissedAt: respondedAt }
        : {}),
    });
    return { kind: "task", task: detailedTask(task, inputRequests) };
  }

  async #restoreStored(
    outcome: StoredInvocation,
    authorization: AuthorizationContext,
  ): Promise<ToolInvocationResult> {
    if (outcome.kind === "result") return outcome;
    const task = await this.#repository.getAuthorized(outcome.taskId, authorization);
    return {
      kind: "task",
      task: detailedTask(
        task,
        await this.#repository.listInputRequests(task.taskId),
        await this.#repository.listObservations(task.taskId),
      ),
    };
  }

  async getTask(
    taskId: string,
    authorization: AuthorizationContext,
  ): Promise<Record<string, unknown>> {
    let task = await this.#repository.getAuthorized(taskId, authorization);
    if (
      !isTerminalState(task.internalState) &&
      task.internalState !== "SCHEDULED" &&
      task.internalState !== "STARTING"
    ) {
      if (task.externalExecutionId === null) return detailedTask(task);
      const snapshot = await this.gateway.getExecution(
        task.taskId,
        task.externalExecutionId,
        executionOptions(authorization),
      );
      task = await this.#repository.applySnapshot(
        task.taskId,
        Number(snapshot.revision),
        stopTransition(task, snapshot, this.clock.now()),
        normalizeInputRequests(snapshot),
      );
    }
    return detailedTask(
      task,
      await this.#repository.listInputRequests(task.taskId),
      await this.#repository.listObservations(task.taskId),
    );
  }

  async recoverAdmission(admission: AdmissionIntentRecord): Promise<ToolInvocationResult> {
    const operation = this.manifest.operations.find(
      (candidate) => candidate.name === admission.operationName,
    );
    if (operation === undefined) throw new Error("RECOVERY_OPERATION_NOT_FOUND");
    return this.#executeOperation(
      operation,
      admission.arguments,
      admission.authorization,
      admission.ttlMs ?? undefined,
      admission.taskId,
      true,
      admission.argumentHash,
      admission.timing,
      {
        acceptedAt: admission.acceptedAt,
        notBefore: admission.notBefore,
        latestStartAt: admission.latestStartAt,
        deadlineAt: admission.deadlineAt,
      },
    );
  }

  async reconcileTask(task: TaskRecord): Promise<"found" | "not_found" | "deferred"> {
    if (task.internalState === "STARTING" && task.externalExecutionId === null) return "deferred";
    const response = await this.gateway.reconcileExecution(
      task.taskId,
      task.operationName,
      task.argumentHash,
      executionOptions({
        hash: task.authorizationContextHash,
        executionMode: task.executionMode,
        simulationId: task.simulationId,
      }),
    );
    if (response.status === "TRANSIENT_UNAVAILABLE") return "deferred";
    if (response.status === "CONFLICT") {
      await this.#repository.failRecoveryNotFound(
        task.taskId,
        "Adapter reported a conflicting execution identity during recovery.",
      );
      return "not_found";
    }
    if (response.status === "NOT_FOUND" || response.snapshot === undefined) {
      await this.#repository.failRecoveryNotFound(
        task.taskId,
        "Adapter execution was not found during recovery.",
      );
      return "not_found";
    }
    const snapshot = response.snapshot;
    await this.#repository.applySnapshot(
      task.taskId,
      Number(snapshot.revision),
      stopTransition(task, snapshot, this.clock.now()),
      normalizeInputRequests(snapshot),
    );
    await this.#repository.noteRecovery(task.taskId);
    return "found";
  }

  async replayPendingCommand(task: TaskRecord, command: PendingCommandRecord): Promise<void> {
    const authorization = {
      hash: task.authorizationContextHash,
      executionMode: task.executionMode,
      simulationId: task.simulationId,
    };
    const identity = {
      taskId: task.taskId,
      operationName: task.operationName,
      argumentHash: task.argumentHash,
      commandSequence: command.commandSequence,
    };
    let ack;
    let completedAnswers: { key: string; hash: string; value: unknown }[] = [];
    if (command.commandType === "CANCEL") {
      ack = await this.gateway.requestCancel(
        task.taskId,
        task.operationName,
        task.argumentHash,
        task.stopReason === "DEADLINE_REACHED" ? "DEADLINE_REACHED" : "USER_REQUESTED",
        command.commandSequence,
        executionOptions(authorization),
      );
    } else if (command.commandType === "UPDATE") {
      const answers = command.payload.answers;
      if (typeof answers !== "object" || answers === null || Array.isArray(answers)) {
        throw new Error("INVALID_RECOVERY_UPDATE_PAYLOAD");
      }
      completedAnswers = Object.entries(answers as Record<string, unknown>).map(([key, value]) => ({
        key,
        value,
        hash: createHash("sha256").update(canonicalize(value)).digest("hex"),
      }));
      ack = await this.gateway.updateExecution(
        identity,
        completedAnswers.map((answer) => ({
          key: answer.key,
          value: answer.value,
          answerHash: answer.hash,
        })),
        executionOptions(authorization),
      );
    } else if (command.commandType === "PAUSE") {
      ack = await this.gateway.pauseExecution(identity, executionOptions(authorization));
    } else {
      ack = await this.gateway.resumeExecution(identity, executionOptions(authorization));
    }
    await this.#repository.acknowledgeCommand(
      task.taskId,
      command.commandSequence,
      ack.accepted,
      ack as unknown as Record<string, unknown>,
    );
    if (ack.accepted && completedAnswers.length > 0) {
      await this.#repository.completeInputAnswers(task.taskId, completedAnswers);
    }
  }

  async getTaskResult(
    taskId: string,
    authorization: AuthorizationContext,
  ): Promise<Record<string, unknown>> {
    const task = await this.#repository.getAuthorized(taskId, authorization);
    if (!isTerminalState(task.internalState)) throw new Error("TASK_NOT_TERMINAL");
    return task.result ?? task.error ?? { content: [], isError: task.mcpStatus !== "completed" };
  }

  async cancelTask(
    taskId: string,
    authorization: AuthorizationContext,
  ): Promise<Record<string, unknown>> {
    this.metrics?.increment("sdar_cancel_requests_total", {
      executionMode: authorization.executionMode,
    });
    let task = await this.#repository.getAuthorized(taskId, authorization);
    this.onTrace?.({
      event: "task.cancel_requested",
      providerId: task.providerId,
      taskId,
      operationName: task.operationName,
      resourceRef: null,
      executionMode: authorization.executionMode,
      correlationId: authorization.correlationId ?? null,
    });
    if (isTerminalState(task.internalState)) return detailedTask(task);
    const requestHash = createHash("sha256").update("cancel:user_requested").digest("hex");
    await this.#repository.beginCancel(taskId, requestHash);
    task = (await this.#repository.getById(taskId)) ?? task;
    return detailedTask(task);
  }

  async updateTask(
    taskId: string,
    answers: Record<string, unknown>,
    authorization: AuthorizationContext,
  ): Promise<Record<string, never>> {
    const task = await this.#repository.getAuthorized(taskId, authorization);
    const requests = await this.#repository.listInputRequests(taskId);
    const ajv = new Ajv2020({ strict: true, allErrors: true });
    const pending: { key: string; hash: string; value: unknown }[] = [];
    for (const [key, value] of Object.entries(answers)) {
      const request = requests.find((candidate) => candidate.key === key);
      if (request === undefined) throw new Error("UNKNOWN_INPUT_REQUEST_KEY");
      const hash = createHash("sha256").update(canonicalize(value)).digest("hex");
      if (request.status === "ANSWERED") {
        if (request.answerHash !== hash) throw new Error("INPUT_ANSWER_CONFLICT");
        continue;
      }
      if (!ajv.compile(request.schema)(value)) throw new Error("INVALID_INPUT_ANSWER");
      pending.push({ key, hash, value });
    }
    if (pending.length === 0) return {};
    const requestHash = createHash("sha256").update(canonicalize(pending)).digest("hex");
    const command = await this.#repository.beginCommand(taskId, "UPDATE", requestHash, {
      answers,
    });
    if (!command.duplicate) {
      const ack = await this.gateway.updateExecution(
        {
          taskId,
          operationName: task.operationName,
          argumentHash: task.argumentHash,
          commandSequence: command.sequence,
        },
        pending.map((answer) => ({
          key: answer.key,
          value: answer.value,
          answerHash: answer.hash,
        })),
        executionOptions(authorization),
      );
      await this.#repository.acknowledgeCommand(
        taskId,
        command.sequence,
        ack.accepted,
        ack as unknown as Record<string, unknown>,
      );
      if (!ack.accepted) throw new Error("ADAPTER_INPUT_REJECTED");
      await this.#repository.completeInputAnswers(taskId, pending);
    }
    return {};
  }

  async controlTask(
    taskId: string,
    commandType: "PAUSE" | "RESUME",
    authorization: AuthorizationContext,
  ): Promise<Record<string, unknown>> {
    const task = await this.#repository.getAuthorized(taskId, authorization);
    const operation = this.manifest.operations.find(
      (candidate) => candidate.name === task.operationName,
    );
    if (!operation?.capabilities.pauseResume) throw new Error("PAUSE_RESUME_NOT_SUPPORTED");
    const requestHash = createHash("sha256").update(commandType).digest("hex");
    const command = await this.#repository.beginCommand(taskId, commandType, requestHash, {});
    if (!command.duplicate) {
      const identity = {
        taskId,
        operationName: task.operationName,
        argumentHash: task.argumentHash,
        commandSequence: command.sequence,
      };
      const ack =
        commandType === "PAUSE"
          ? await this.gateway.pauseExecution(identity, executionOptions(authorization))
          : await this.gateway.resumeExecution(identity, executionOptions(authorization));
      await this.#repository.acknowledgeCommand(
        taskId,
        command.sequence,
        ack.accepted,
        ack as unknown as Record<string, unknown>,
      );
      if (!ack.accepted) throw new Error("ADAPTER_CONTROL_REJECTED");
    }
    return this.getTask(taskId, authorization);
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

function normalizeInputRequests(snapshot: ExecutionSnapshot) {
  return (snapshot.inputRequests ?? []).map((request) => ({
    key: request.key,
    description: request.description,
    schema: protoStructToJson(request.inputSchema),
    required: request.required,
    status: "OPEN" as const,
  }));
}

function resultFromStart(
  response: Awaited<ReturnType<GrpcAdapterGateway["startOperation"]>>,
): Record<string, unknown> {
  if (response.rejected !== undefined) return rejectionResult(response.rejected);
  const snapshot = response.accepted?.initialSnapshot;
  if (snapshot === undefined) throw new Error("ADAPTER_START_RESPONSE_MISSING_RESULT");
  if (snapshot.state === "SUCCEEDED") {
    return {
      content: [{ type: "text", text: snapshot.message || "Operation completed." }],
      isError: false,
      structuredContent: protoStructToJson(snapshot.result),
    };
  }
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
  return createHash("sha256").update(canonicalize(value)).digest("hex");
}

function detailedTask(
  task: TaskRecord,
  inputRequests: {
    key: string;
    description: string;
    schema: Record<string, unknown>;
    required: boolean;
    status: "OPEN" | "ANSWERED";
  }[] = [],
  observations: {
    revision: number;
    type: string;
    occurredAt: Date;
    reasonCode: string | null;
    payload: Record<string, unknown>;
  }[] = [],
): Record<string, unknown> {
  return {
    taskId: task.taskId,
    status: task.mcpStatus,
    statusMessage: task.statusMessage ?? undefined,
    createdAt: task.createdAt.toISOString(),
    lastUpdatedAt: task.updatedAt.toISOString(),
    ttl: task.ttlMs,
    pollInterval: task.pollIntervalMs,
    ...(inputRequests.some((request) => request.status === "OPEN")
      ? {
          inputRequests: inputRequests
            .filter((request) => request.status === "OPEN")
            .map(({ status, ...request }) => {
              void status;
              return request;
            }),
        }
      : {}),
    ...(task.result === null ? {} : { result: task.result }),
    ...(task.error === null ? {} : { error: task.error }),
    _meta: {
      "io.sdar/taskExecution": {
        profileVersion: "1.0",
        substate: task.substate,
        observationRevision: task.adapterRevision,
        executionMode: task.executionMode,
        timing: {
          acceptedAt: task.acceptedAt.toISOString(),
          notBefore: task.notBefore?.toISOString(),
          latestStartAt: task.latestStartAt?.toISOString(),
          actualStartedAt: task.actualStartedAt?.toISOString() ?? null,
          startStopRequestedAt: task.startStopRequestedAt?.toISOString() ?? null,
          invocationAttempt: task.invocationAttempt,
          nextStartAttemptAt: task.nextStartAttemptAt?.toISOString() ?? null,
          deadlineAt: task.deadlineAt?.toISOString() ?? null,
        },
        observations: observations.map((observation) => ({
          revision: observation.revision,
          type: observation.type,
          occurredAt: observation.occurredAt.toISOString(),
          ...(observation.reasonCode === null ? {} : { reasonCode: observation.reasonCode }),
          ...observation.payload,
        })),
      },
    },
  };
}

function deadlineReached(message: string, completedAt: Date) {
  return {
    internalState: "TERMINAL_COMPLETED" as const,
    mcpStatus: "completed" as const,
    substate: null,
    statusMessage: message || "Maximum elapsed time reached after safe stop.",
    result: {
      content: [{ type: "text", text: message || "Maximum elapsed time reached." }],
      isError: true,
      structuredContent: {
        outcome: "deadline_reached",
        reasonCode: "MAX_ELAPSED_TIME_REACHED",
        retryable: true,
        completedAt: completedAt.toISOString(),
      },
    },
    error: null,
    terminal: true,
    observationType: "task.progress",
  };
}

function startWindowMissed(completedAt: Date, message: string): Record<string, unknown> {
  return {
    content: [{ type: "text", text: message }],
    isError: true,
    structuredContent: {
      outcome: "start_window_missed",
      reasonCode: "START_WINDOW_MISSED",
      retryable: true,
      completedAt: completedAt.toISOString(),
    },
  };
}

function startWindowMissedTransition(message: string, completedAt: Date) {
  return {
    internalState: "TERMINAL_COMPLETED" as const,
    mcpStatus: "completed" as const,
    substate: null,
    statusMessage: message || "Start window was missed after safe stop.",
    result: startWindowMissed(completedAt, message || "Start window was missed after safe stop."),
    error: null,
    terminal: true,
    observationType: "task.start_window_missed",
  };
}

function stopTransition(task: TaskRecord, snapshot: ExecutionSnapshot, completedAt: Date) {
  if (snapshot.state === "CANCELLED" && task.stopReason === "DEADLINE_REACHED") {
    return deadlineReached(snapshot.message, completedAt);
  }
  if (snapshot.state === "CANCELLED" && task.stopReason === "START_WINDOW_MISSED") {
    return startWindowMissedTransition(snapshot.message, completedAt);
  }
  return mapAdapterSnapshot(normalizeSnapshot(snapshot));
}

function snapshotHasStarted(state: string): boolean {
  return [
    "RUNNING",
    "PAUSED",
    "RESUMING",
    "SUCCEEDED",
    "BUSINESS_FAILED",
    "PARTIALLY_COMPLETED",
    "TECHNICAL_FAILED",
  ].includes(state);
}

function storedInvocation(invocation: ToolInvocationResult): StoredInvocation {
  if (invocation.kind === "result") return invocation;
  return { kind: "task", taskId: String(invocation.task.taskId) };
}

function executionOptions(authorization: AuthorizationContext) {
  return {
    authorizationContextHash: authorization.hash,
    executionMode: authorization.executionMode,
    simulationId: authorization.simulationId,
    ...(authorization.correlationId === undefined
      ? {}
      : { correlationId: authorization.correlationId }),
  };
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

function resourceReference(
  operation: ValidatedOperation,
  argumentsValue: Record<string, unknown>,
): string | null {
  const pointer = operation.resourceBinding?.resourceIdJsonPointer;
  if (operation.resourceBinding?.mode !== "ARGUMENT_REFERENCE" || !pointer?.startsWith("/")) {
    return null;
  }
  let current: unknown = argumentsValue;
  for (const encoded of pointer.slice(1).split("/")) {
    if (typeof current !== "object" || current === null || Array.isArray(current)) return null;
    const key = encoded.replaceAll("~1", "/").replaceAll("~0", "~");
    current = (current as Record<string, unknown>)[key];
  }
  return typeof current === "string" || typeof current === "number" ? String(current) : null;
}

function toAdapterAvailabilityCheck(check: AvailabilityCheck): AvailabilityCheckInput {
  if (isUnresolvedArguments(check.arguments)) {
    return {
      requestId: check.requestId,
      operationName: check.operationName,
      unresolvedArguments: {
        knownArguments: check.arguments.knownArguments,
        unresolvedPaths: check.arguments.unresolvedPaths,
      },
      timing: toAdapterTiming(check.timing),
    };
  }
  return {
    requestId: check.requestId,
    operationName: check.operationName,
    arguments: check.arguments,
    timing: toAdapterTiming(check.timing),
  };
}

function isUnresolvedArguments(value: AvailabilityCheck["arguments"]): value is {
  unresolved: true;
  knownArguments: Record<string, unknown>;
  unresolvedPaths: string[];
} {
  return "unresolved" in value && value.unresolved === true;
}

function toAdapterTiming(timing: AvailabilityCheck["timing"]): Record<string, unknown> {
  const start = timing?.start;
  return {
    start: {
      mode: (start?.mode ?? "immediate").toUpperCase(),
      ...(start?.scheduledAt === undefined
        ? {}
        : { scheduledAt: dateToProtoTimestamp(new Date(start.scheduledAt)) }),
      startToleranceMs: String(start?.startToleranceMs ?? 0),
    },
    ...(timing?.maxElapsedMs === undefined || timing.maxElapsedMs === null
      ? {}
      : { maxElapsedMs: String(timing.maxElapsedMs) }),
  };
}

function fromAdapterAvailability(result: {
  requestId: string;
  operationName: string;
  availability: string;
  riskLevel: string;
  reasonCode: string;
  description: string;
  validUntil?: unknown;
  earliestStartTime?: unknown;
  nextAvailableWindows: { startTime?: unknown; endTime?: unknown }[];
  estimatedDelayMs: string | number;
  possibleEffects: string[];
}) {
  return {
    requestId: result.requestId,
    operationName: result.operationName,
    availability: result.availability.toLowerCase() as
      "available" | "restricted" | "disabled" | "unknown",
    riskLevel: result.riskLevel.toLowerCase() as
      "low" | "medium" | "high" | "critical" | "unspecified",
    ...(result.reasonCode ? { reasonCode: result.reasonCode } : {}),
    ...(result.description ? { description: result.description } : {}),
    ...(hasTimestamp(result.validUntil)
      ? { validUntil: protoTimestampToDate(result.validUntil).toISOString() }
      : {}),
    ...(hasTimestamp(result.earliestStartTime)
      ? { earliestStartTime: protoTimestampToDate(result.earliestStartTime).toISOString() }
      : {}),
    nextAvailableWindows: result.nextAvailableWindows
      .filter((window) => hasTimestamp(window.startTime) && hasTimestamp(window.endTime))
      .map((window) => ({
        startTime: protoTimestampToDate(window.startTime).toISOString(),
        endTime: protoTimestampToDate(window.endTime).toISOString(),
      })),
    estimatedDelayMs: Number(result.estimatedDelayMs),
    possibleEffects: result.possibleEffects,
  };
}

function hasTimestamp(value: unknown): boolean {
  return (
    typeof value === "object" &&
    value !== null &&
    "seconds" in value &&
    Number.isFinite(Number((value as { seconds?: unknown }).seconds)) &&
    Number((value as { seconds?: unknown }).seconds) !== 0
  );
}

function protoTimestampToDate(value: unknown): Date {
  if (!hasTimestamp(value)) throw new Error("INVALID_AVAILABILITY_TIMESTAMP");
  const timestamp = value as { seconds: string | number; nanos?: number };
  return new Date(Number(timestamp.seconds) * 1000 + (timestamp.nanos ?? 0) / 1_000_000);
}

function dateToProtoTimestamp(value: Date): Record<string, string | number> {
  if (!Number.isFinite(value.getTime())) throw new Error("INVALID_SCHEDULED_AT");
  return { seconds: String(Math.floor(value.getTime() / 1000)), nanos: 0 };
}

function isAvailabilityContractError(error: unknown): boolean {
  return (
    error instanceof Error && /^(AVAILABILITY_|AVAILABLE_|RESTRICTED_|INVALID_)/.test(error.message)
  );
}
