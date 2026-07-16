import * as grpc from "@grpc/grpc-js";
import { createHash, randomUUID } from "node:crypto";
import { adapterClientConstructor } from "./proto.js";
import { jsonToProtoStruct, jsonToProtoValue } from "./struct.js";
import { ADAPTER_PROTOCOL_VERSION } from "./types.js";
import type {
  AvailabilityCheckInput,
  CheckAvailabilityResponse,
  CommandAck,
  ExecutionSnapshot,
  ProviderManifest,
  ReconcileExecutionResponse,
  StartOperationResponse,
} from "./types.js";

type AdapterClient = grpc.Client & {
  describeProvider(
    request: unknown,
    options: grpc.CallOptions,
    callback: grpc.requestCallback<ProviderManifest>,
  ): grpc.ClientUnaryCall;
  getExecution(
    request: unknown,
    options: grpc.CallOptions,
    callback: grpc.requestCallback<ExecutionSnapshot>,
  ): grpc.ClientUnaryCall;
  startOperation(
    request: unknown,
    options: grpc.CallOptions,
    callback: grpc.requestCallback<StartOperationResponse>,
  ): grpc.ClientUnaryCall;
  checkAvailability(
    request: unknown,
    options: grpc.CallOptions,
    callback: grpc.requestCallback<CheckAvailabilityResponse>,
  ): grpc.ClientUnaryCall;
  reconcileExecution(
    request: unknown,
    options: grpc.CallOptions,
    callback: grpc.requestCallback<ReconcileExecutionResponse>,
  ): grpc.ClientUnaryCall;
  requestCancel(
    request: unknown,
    options: grpc.CallOptions,
    callback: grpc.requestCallback<CommandAck>,
  ): grpc.ClientUnaryCall;
  updateExecution(
    request: unknown,
    options: grpc.CallOptions,
    callback: grpc.requestCallback<CommandAck>,
  ): grpc.ClientUnaryCall;
  pauseExecution(
    request: unknown,
    options: grpc.CallOptions,
    callback: grpc.requestCallback<CommandAck>,
  ): grpc.ClientUnaryCall;
  resumeExecution(
    request: unknown,
    options: grpc.CallOptions,
    callback: grpc.requestCallback<CommandAck>,
  ): grpc.ClientUnaryCall;
};

export interface AdapterGatewayOptions {
  endpoint: string;
  providerId: string;
  credentials?: grpc.ChannelCredentials;
  timeoutMs?: number;
  onRpc?: (method: string, outcome: "success" | "error", durationMs: number) => void;
}

export interface StartOperationOptions {
  taskId?: string;
  authorizationContextHash?: string;
  executionMode?: "live" | "simulation" | "historical-replay";
  simulationId?: string | null;
  argumentHash?: string;
  invocationAttempt?: number;
  timing?: Record<string, unknown>;
  correlationId?: string;
}

export class GrpcAdapterGateway {
  readonly #client: AdapterClient;
  readonly #providerId: string;
  readonly #timeoutMs: number;
  readonly #onRpc: AdapterGatewayOptions["onRpc"];

  constructor(options: AdapterGatewayOptions) {
    const Client = adapterClientConstructor();
    this.#client = new Client(
      options.endpoint,
      options.credentials ?? grpc.credentials.createInsecure(),
    ) as unknown as AdapterClient;
    this.#providerId = options.providerId;
    this.#timeoutMs = options.timeoutMs ?? 5_000;
    this.#onRpc = options.onRpc;
  }

  describeProvider(): Promise<ProviderManifest> {
    return this.#unary<ProviderManifest>("describeProvider", {
      metadata: this.#metadata(),
    });
  }

  getExecution(
    taskId: string,
    externalExecutionId = "",
    options: StartOperationOptions = {},
  ): Promise<ExecutionSnapshot> {
    return this.#unary<ExecutionSnapshot>("getExecution", {
      metadata: this.#metadata(options.correlationId),
      taskId,
      externalExecutionId,
      executionContext: {
        ...this.#executionContext(options),
      },
    });
  }

  checkAvailability(
    checks: AvailabilityCheckInput[],
    options: StartOperationOptions = {},
  ): Promise<CheckAvailabilityResponse> {
    return this.#unary<CheckAvailabilityResponse>("checkAvailability", {
      metadata: this.#metadata(options.correlationId),
      executionContext: this.#executionContext(options),
      checks: checks.map((check) => ({
        requestId: check.requestId,
        operationName: check.operationName,
        ...(check.arguments === undefined
          ? {
              unresolvedArguments: {
                knownArguments: jsonToProtoStruct(check.unresolvedArguments?.knownArguments ?? {}),
                unresolvedPaths: check.unresolvedArguments?.unresolvedPaths ?? [],
              },
              argumentsValue: "unresolvedArguments",
            }
          : {
              arguments: jsonToProtoStruct(check.arguments),
              argumentsValue: "arguments",
            }),
        timing: check.timing ?? { start: { mode: "IMMEDIATE" } },
      })),
    });
  }

  reconcileExecution(
    taskId: string,
    operationName: string,
    argumentHash: string,
    options: StartOperationOptions = {},
  ): Promise<ReconcileExecutionResponse> {
    return this.#unary<ReconcileExecutionResponse>("reconcileExecution", {
      metadata: this.#metadata(options.correlationId),
      taskId,
      operationName,
      argumentHash,
      executionContext: this.#executionContext(options),
    });
  }

  requestCancel(
    taskId: string,
    operationName: string,
    argumentHash: string,
    reason: "USER_REQUESTED" | "DEADLINE_REACHED",
    commandSequence: number,
    options: StartOperationOptions = {},
  ): Promise<CommandAck> {
    return this.#unary<CommandAck>("requestCancel", {
      metadata: this.#metadata(options.correlationId),
      identity: {
        taskId,
        operationName,
        argumentHash,
        executionContext: this.#executionContext(options),
        commandSequence,
      },
      reason,
    });
  }

  updateExecution(
    identity: {
      taskId: string;
      operationName: string;
      argumentHash: string;
      commandSequence: number;
    },
    inputs: { key: string; value: unknown; answerHash: string }[],
    options: StartOperationOptions = {},
  ): Promise<CommandAck> {
    return this.#unary<CommandAck>("updateExecution", {
      metadata: this.#metadata(options.correlationId),
      identity: {
        ...identity,
        executionContext: this.#executionContext(options),
      },
      inputs: inputs.map((input) => ({
        inputRequestKey: input.key,
        value: jsonToProtoValue(input.value),
        answerHash: input.answerHash,
      })),
    });
  }

  pauseExecution(
    identity: {
      taskId: string;
      operationName: string;
      argumentHash: string;
      commandSequence: number;
    },
    options: StartOperationOptions = {},
  ): Promise<CommandAck> {
    return this.#unary<CommandAck>("pauseExecution", {
      metadata: this.#metadata(options.correlationId),
      identity: { ...identity, executionContext: this.#executionContext(options) },
      reasonCode: "CLIENT_REQUESTED",
    });
  }

  resumeExecution(
    identity: {
      taskId: string;
      operationName: string;
      argumentHash: string;
      commandSequence: number;
    },
    options: StartOperationOptions = {},
  ): Promise<CommandAck> {
    return this.#unary<CommandAck>("resumeExecution", {
      metadata: this.#metadata(options.correlationId),
      identity: { ...identity, executionContext: this.#executionContext(options) },
      reasonCode: "CLIENT_REQUESTED",
    });
  }

  startOperation(
    operationName: string,
    argumentsValue: Record<string, unknown>,
    options: StartOperationOptions = {},
  ): Promise<StartOperationResponse> {
    const taskId = options.taskId ?? randomUUID();
    const canonicalArguments = JSON.stringify(argumentsValue, Object.keys(argumentsValue).sort());
    return this.#unary<StartOperationResponse>("startOperation", {
      metadata: this.#metadata(options.correlationId),
      taskId,
      operationName,
      arguments: jsonToProtoStruct(argumentsValue),
      timing: options.timing ?? { start: { mode: "IMMEDIATE", startToleranceMs: "0" } },
      executionContext: this.#executionContext(options),
      argumentHash:
        options.argumentHash ?? createHash("sha256").update(canonicalArguments).digest("hex"),
      invocationAttempt: options.invocationAttempt ?? 1,
    });
  }

  close(): void {
    this.#client.close();
  }

  #metadata(correlationId: string = randomUUID()): Record<string, string> {
    return {
      adapterProtocolVersion: ADAPTER_PROTOCOL_VERSION,
      providerId: this.#providerId,
      correlationId,
    };
  }

  #executionContext(options: StartOperationOptions): Record<string, string> {
    return {
      authorizationContextHash: options.authorizationContextHash ?? "r2-development",
      executionMode: (options.executionMode ?? "live").replace("-", "_").toUpperCase(),
      simulationId: options.simulationId ?? "",
      correlationId: options.correlationId ?? randomUUID(),
    };
  }

  #unary<T>(
    method:
      | "describeProvider"
      | "getExecution"
      | "startOperation"
      | "checkAvailability"
      | "reconcileExecution"
      | "requestCancel"
      | "updateExecution"
      | "pauseExecution"
      | "resumeExecution",
    request: unknown,
  ): Promise<T> {
    const deadline = new Date(Date.now() + this.#timeoutMs);
    const startedAt = performance.now();
    return new Promise<T>((resolve, reject) => {
      const callback: grpc.requestCallback<T> = (error, value) => {
        if (error !== null) {
          this.#onRpc?.(method, "error", performance.now() - startedAt);
          reject(error);
        } else if (value === undefined) {
          this.#onRpc?.(method, "error", performance.now() - startedAt);
          reject(new Error(`Adapter ${method} returned no value`));
        } else {
          this.#onRpc?.(method, "success", performance.now() - startedAt);
          resolve(value);
        }
      };
      if (method === "describeProvider") {
        this.#client.describeProvider(
          request,
          { deadline },
          callback as grpc.requestCallback<ProviderManifest>,
        );
      } else if (method === "getExecution") {
        this.#client.getExecution(
          request,
          { deadline },
          callback as grpc.requestCallback<ExecutionSnapshot>,
        );
      } else if (method === "startOperation") {
        this.#client.startOperation(
          request,
          { deadline },
          callback as grpc.requestCallback<StartOperationResponse>,
        );
      } else if (method === "checkAvailability") {
        this.#client.checkAvailability(
          request,
          { deadline },
          callback as grpc.requestCallback<CheckAvailabilityResponse>,
        );
      } else if (method === "reconcileExecution") {
        this.#client.reconcileExecution(
          request,
          { deadline },
          callback as grpc.requestCallback<ReconcileExecutionResponse>,
        );
      } else if (method === "requestCancel") {
        this.#client.requestCancel(
          request,
          { deadline },
          callback as grpc.requestCallback<CommandAck>,
        );
      } else {
        this.#client[method](request, { deadline }, callback as grpc.requestCallback<CommandAck>);
      }
    });
  }
}
