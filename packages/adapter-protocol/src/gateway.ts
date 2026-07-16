import * as grpc from "@grpc/grpc-js";
import { randomUUID } from "node:crypto";
import { adapterClientConstructor } from "./proto.js";
import { ADAPTER_PROTOCOL_VERSION } from "./types.js";
import type { ExecutionSnapshot, ProviderManifest } from "./types.js";

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
};

export interface AdapterGatewayOptions {
  endpoint: string;
  providerId: string;
  credentials?: grpc.ChannelCredentials;
  timeoutMs?: number;
}

export class GrpcAdapterGateway {
  readonly #client: AdapterClient;
  readonly #providerId: string;
  readonly #timeoutMs: number;

  constructor(options: AdapterGatewayOptions) {
    const Client = adapterClientConstructor();
    this.#client = new Client(
      options.endpoint,
      options.credentials ?? grpc.credentials.createInsecure(),
    ) as unknown as AdapterClient;
    this.#providerId = options.providerId;
    this.#timeoutMs = options.timeoutMs ?? 5_000;
  }

  describeProvider(): Promise<ProviderManifest> {
    return this.#unary<ProviderManifest>("describeProvider", {
      metadata: this.#metadata(),
    });
  }

  getExecution(taskId: string, externalExecutionId = ""): Promise<ExecutionSnapshot> {
    return this.#unary<ExecutionSnapshot>("getExecution", {
      metadata: this.#metadata(),
      taskId,
      externalExecutionId,
      executionContext: {
        authorizationContextHash: "runtime-health",
        executionMode: "LIVE",
        correlationId: randomUUID(),
      },
    });
  }

  close(): void {
    this.#client.close();
  }

  #metadata(): Record<string, string> {
    return {
      adapterProtocolVersion: ADAPTER_PROTOCOL_VERSION,
      providerId: this.#providerId,
      correlationId: randomUUID(),
    };
  }

  #unary<T>(method: "describeProvider" | "getExecution", request: unknown): Promise<T> {
    const deadline = new Date(Date.now() + this.#timeoutMs);
    return new Promise<T>((resolve, reject) => {
      const callback: grpc.requestCallback<T> = (error, value) => {
        if (error !== null) reject(error);
        else if (value === undefined) reject(new Error(`Adapter ${method} returned no value`));
        else resolve(value);
      };
      if (method === "describeProvider") {
        this.#client.describeProvider(
          request,
          { deadline },
          callback as grpc.requestCallback<ProviderManifest>,
        );
      } else {
        this.#client.getExecution(
          request,
          { deadline },
          callback as grpc.requestCallback<ExecutionSnapshot>,
        );
      }
    });
  }
}
