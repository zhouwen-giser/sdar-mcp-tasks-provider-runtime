import * as grpc from "@grpc/grpc-js";
import { readFileSync } from "node:fs";
import {
  adapterServiceDefinition,
  jsonToProtoStruct,
  protoStructToJson,
} from "../../../packages/adapter-protocol/src/index.js";
import type { HomeAssistantRestClient } from "./home-assistant/rest-client.js";
import { normalizeLightState } from "./home-assistant/state-normalizer.js";
import { providerManifest } from "./manifest.js";
import type { LightResourceRegistry } from "./resources/registry.js";
import { publicLightState } from "./resources/light-resource.js";
import type { LightExecutionEngine } from "./execution/execution-engine.js";
import type { ExecutionStore } from "./execution/execution-store.js";
import { executionSnapshot, timestamp } from "./execution/snapshots.js";
import { ProviderError, safeProviderError } from "./errors.js";
import type { ExecutionContextRecord, LightOperationName } from "./types.js";

type UnaryCall<T> = grpc.ServerUnaryCall<T, unknown>;
export interface ServerOptions {
  providerId: string;
  providerVersion: string;
  host: string;
  port: number;
  tlsMode: "disabled" | "required";
  tlsCaPath?: string;
  tlsCertPath?: string;
  tlsKeyPath?: string;
}
interface StartRequest {
  taskId?: string;
  operationName?: string;
  arguments?: unknown;
  argumentHash?: string;
  executionContext?: Record<string, unknown>;
}
interface ReconcileRequest {
  taskId?: string;
  operationName?: string;
  argumentHash?: string;
  externalExecutionId?: string;
  executionContext?: Record<string, unknown>;
}
interface CommandRequest {
  identity?: { taskId?: string; commandSequence?: string | number; [key: string]: unknown };
}

export class HomeAssistantLightProviderServer {
  readonly #server = new grpc.Server();
  #started = false;
  constructor(
    readonly options: ServerOptions,
    readonly registry: LightResourceRegistry,
    readonly rest: HomeAssistantRestClient,
    readonly store: ExecutionStore,
    readonly engine: LightExecutionEngine,
  ) {
    this.#server.addService(adapterServiceDefinition(), this.#handlers());
  }
  start(): Promise<number> {
    return new Promise((resolve, reject) =>
      this.#server.bindAsync(
        `${this.options.host}:${String(this.options.port)}`,
        serverCredentials(this.options),
        (error, port) => {
          if (error !== null) reject(error);
          else {
            this.#started = true;
            resolve(port);
          }
        },
      ),
    );
  }
  close(): Promise<void> {
    if (!this.#started) return Promise.resolve();
    return new Promise((resolve) => this.#server.tryShutdown(() => resolve()));
  }

  #handlers(): grpc.UntypedServiceImplementation {
    return {
      describeProvider: (_call: UnaryCall<unknown>, callback: grpc.sendUnaryData<unknown>) =>
        callback(null, providerManifest(this.options.providerId, this.options.providerVersion)),
      listResources: (_call: UnaryCall<unknown>, callback: grpc.sendUnaryData<unknown>) =>
        callback(null, {
          resources: this.registry.list().map((resource) => ({
            resourceId: resource.resourceId,
            displayName: resource.displayName,
            resourceType: "home_assistant.light",
            enabled: resource.enabled,
            health: "unknown",
            labels: {},
            metadata: jsonToProtoStruct({ expectedCapabilities: resource.expectedCapabilities }),
          })),
          nextPageToken: "",
        }),
      checkAvailability: (
        call: UnaryCall<{
          checks?: { requestId?: string; operationName?: string; arguments?: unknown }[];
        }>,
        callback: grpc.sendUnaryData<unknown>,
      ) => {
        void Promise.all(
          (call.request.checks ?? []).map(async (check) => this.#availability(check)),
        )
          .then((checks) =>
            callback(null, { profileVersion: "1.0", checkedAt: timestamp(new Date()), checks }),
          )
          .catch((error: unknown) => callback(serviceError(error)));
      },
      startOperation: (call: UnaryCall<StartRequest>, callback: grpc.sendUnaryData<unknown>) => {
        void this.#start(call.request)
          .then((response) => callback(null, response))
          .catch((error: unknown) => callback(serviceError(error)));
      },
      getExecution: (
        call: UnaryCall<{ taskId?: string }>,
        callback: grpc.sendUnaryData<unknown>,
      ) => {
        const execution = this.store.get(call.request.taskId ?? "");
        if (execution === undefined) callback(notFound());
        else callback(null, executionSnapshot(execution));
      },
      reconcileExecution: (
        call: UnaryCall<ReconcileRequest>,
        callback: grpc.sendUnaryData<unknown>,
      ) => callback(null, this.#reconcile(call.request)),
      requestCancel: (call: UnaryCall<CommandRequest>, callback: grpc.sendUnaryData<unknown>) =>
        callback(null, this.#unsupportedCommand(call.request, "cancel", "CANCEL_NOT_SUPPORTED")),
      updateExecution: (call: UnaryCall<CommandRequest>, callback: grpc.sendUnaryData<unknown>) =>
        callback(null, this.#unsupportedCommand(call.request, "update", "UPDATE_NOT_SUPPORTED")),
      pauseExecution: (call: UnaryCall<CommandRequest>, callback: grpc.sendUnaryData<unknown>) =>
        callback(null, this.#unsupportedCommand(call.request, "pause", "PAUSE_NOT_SUPPORTED")),
      resumeExecution: (call: UnaryCall<CommandRequest>, callback: grpc.sendUnaryData<unknown>) =>
        callback(null, this.#unsupportedCommand(call.request, "resume", "RESUME_NOT_SUPPORTED")),
      streamExecutionEvents: (call: grpc.ServerWritableStream<unknown, unknown>) => call.end(),
    };
  }

  async #availability(check: {
    requestId?: string;
    operationName?: string;
    arguments?: unknown;
  }): Promise<Record<string, unknown>> {
    const base = {
      requestId: check.requestId ?? "",
      operationName: check.operationName ?? "",
      riskLevel: "LOW",
    };
    try {
      const argumentsValue = protoStructToJson(check.arguments);
      const resourceId =
        typeof argumentsValue.resourceId === "string" ? argumentsValue.resourceId : "";
      const resource = this.registry.require(resourceId);
      const state = normalizeLightState(
        resource.resourceId,
        await this.rest.getState(resource.entityId),
      );
      if (check.operationName === "light_set_brightness" && !state.supportsBrightness)
        return {
          ...base,
          availability: "DISABLED",
          reasonCode: "BRIGHTNESS_NOT_SUPPORTED",
          description: "The configured light does not report brightness support.",
        };
      return {
        ...base,
        availability: state.reachable ? "AVAILABLE" : "UNKNOWN",
        reasonCode: state.reachable ? "AVAILABLE" : "RESOURCE_STATE_UNKNOWN",
        description: state.reachable
          ? "The configured light is reachable."
          : "The configured light state is unavailable.",
        validUntil: timestamp(new Date(Date.now() + 5000)),
      };
    } catch (error) {
      const safe = safeProviderError(error);
      return {
        ...base,
        availability:
          safe.reasonCode === "RESOURCE_DISABLED" || safe.reasonCode === "RESOURCE_NOT_CONFIGURED"
            ? "DISABLED"
            : "UNKNOWN",
        reasonCode: safe.reasonCode,
        description: safe.reasonCode,
      };
    }
  }

  async #start(request: StartRequest): Promise<Record<string, unknown>> {
    try {
      const operationName = requireOperation(request.operationName);
      const argumentsValue = protoStructToJson(request.arguments);
      const resourceId = requireString(argumentsValue.resourceId);
      const context = executionContext(request.executionContext);
      if (operationName === "light_get_state") {
        const resource = this.registry.require(resourceId);
        const normalized = normalizeLightState(
          resourceId,
          await this.rest.getState(resource.entityId),
        );
        await this.engine.observe(normalized);
        const externalExecutionId = `sync-${request.taskId ?? "query"}`;
        const snapshot = {
          taskId: request.taskId ?? "",
          externalExecutionId,
          operationName,
          argumentHash: request.argumentHash ?? "",
          executionContext: context,
          state: "SUCCEEDED",
          revision: "1",
          reasonCode: "HOME_ASSISTANT_STATE_READ",
          message: "Light state read.",
          result: jsonToProtoStruct(publicLightState(normalized)),
          observedAt: timestamp(new Date(normalized.observedAt)),
        };
        return { accepted: { externalExecutionId, initialSnapshot: snapshot }, result: "accepted" };
      }
      const execution = await this.engine.start({
        taskId: requireString(request.taskId),
        operationName,
        resourceId,
        ...(operationName === "light_set_power"
          ? { power: requirePower(argumentsValue.power) }
          : { brightnessPercent: requireBrightness(argumentsValue.brightnessPercent) }),
        argumentHash: requireString(request.argumentHash),
        executionContext: context,
      });
      return {
        accepted: {
          externalExecutionId: execution.externalExecutionId,
          initialSnapshot: executionSnapshot(execution),
        },
        result: "accepted",
      };
    } catch (error) {
      const safe = safeProviderError(error);
      return rejection(safe.reasonCode, safe.retryable);
    }
  }

  #reconcile(request: ReconcileRequest): Record<string, unknown> {
    const execution = this.store.get(request.taskId ?? "");
    if (execution === undefined)
      return {
        status: "NOT_FOUND",
        reasonCode: "EXECUTION_NOT_FOUND",
        message: "Execution does not exist.",
        retryable: false,
      };
    if (
      execution.operationName !== request.operationName ||
      execution.argumentHash !== request.argumentHash ||
      ((request.externalExecutionId ?? "") !== "" &&
        execution.externalExecutionId !== request.externalExecutionId) ||
      !sameContext(execution.executionContext, request.executionContext)
    )
      return {
        status: "CONFLICT",
        reasonCode: "TASK_IDENTITY_CONFLICT",
        message: "Task identity conflicts with the persisted execution.",
        retryable: false,
      };
    return {
      status: "FOUND",
      snapshot: executionSnapshot(execution),
      externalExecutionId: execution.externalExecutionId,
      reasonCode: "EXECUTION_FOUND",
      message: "Execution recovered.",
      retryable: false,
    };
  }
  #unsupportedCommand(
    request: CommandRequest,
    command: string,
    reasonCode: string,
  ): Record<string, unknown> {
    const taskId = request.identity?.taskId ?? "";
    const execution = this.store.get(taskId);
    const key = `${command}:${String(request.identity?.commandSequence ?? 0)}`;
    const existing = execution?.commandAcks[key];
    if (existing !== undefined) return existing;
    const ack = {
      accepted: false,
      reasonCode,
      message: reasonCode,
      commandSequence: request.identity?.commandSequence ?? "0",
      identity: request.identity,
    };
    if (execution !== undefined) {
      execution.commandAcks[key] = ack;
      this.store.set(execution);
    }
    return ack;
  }
}

function rejection(reasonCode: string, retryable: boolean): Record<string, unknown> {
  return { rejected: { reasonCode, message: reasonCode, retryable }, result: "rejected" };
}
function requireString(value: unknown): string {
  if (typeof value !== "string" || value.length === 0)
    throw new ProviderError("HOME_ASSISTANT_BAD_REQUEST", false);
  return value;
}
function requireOperation(value: unknown): LightOperationName {
  if (
    value !== "light_get_state" &&
    value !== "light_set_power" &&
    value !== "light_set_brightness"
  )
    throw new ProviderError("HOME_ASSISTANT_BAD_REQUEST", false);
  return value;
}
function requirePower(value: unknown): "on" | "off" {
  if (value !== "on" && value !== "off")
    throw new ProviderError("HOME_ASSISTANT_BAD_REQUEST", false);
  return value;
}
function requireBrightness(value: unknown): number {
  if (!Number.isInteger(value) || typeof value !== "number" || value < 1 || value > 100)
    throw new ProviderError("HOME_ASSISTANT_BAD_REQUEST", false);
  return value;
}
function executionContext(value: Record<string, unknown> | undefined): ExecutionContextRecord {
  return {
    authorizationContextHash: stringValue(value?.authorizationContextHash),
    executionMode: stringValue(value?.executionMode),
    simulationId: stringValue(value?.simulationId),
    correlationId: stringValue(value?.correlationId),
  };
}
function stringValue(value: unknown): string {
  return typeof value === "string" ? value : "";
}
function sameContext(
  expected: ExecutionContextRecord,
  actual: Record<string, unknown> | undefined,
): boolean {
  const value = executionContext(actual);
  return (
    expected.authorizationContextHash === value.authorizationContextHash &&
    expected.executionMode === value.executionMode &&
    expected.simulationId === value.simulationId
  );
}
function notFound(): grpc.ServiceError {
  return Object.assign(new Error("EXECUTION_NOT_FOUND"), {
    code: grpc.status.NOT_FOUND,
  }) as grpc.ServiceError;
}
function serviceError(error: unknown): grpc.ServiceError {
  const safe = safeProviderError(error);
  return Object.assign(new Error(safe.reasonCode), {
    code: grpc.status.INTERNAL,
    details: safe.reasonCode,
    metadata: new grpc.Metadata(),
  });
}
function serverCredentials(options: ServerOptions): grpc.ServerCredentials {
  if (options.tlsMode === "disabled") return grpc.ServerCredentials.createInsecure();
  if (
    options.tlsCaPath === undefined ||
    options.tlsCertPath === undefined ||
    options.tlsKeyPath === undefined
  )
    throw new Error("ADAPTER_MTLS_FILES_REQUIRED");
  return grpc.ServerCredentials.createSsl(
    readFileSync(options.tlsCaPath),
    [
      {
        private_key: readFileSync(options.tlsKeyPath),
        cert_chain: readFileSync(options.tlsCertPath),
      },
    ],
    true,
  );
}
