import * as grpc from "@grpc/grpc-js";
import { readFileSync } from "node:fs";
import { telemetryClientConstructor } from "../../../../packages/provider-telemetry/src/index.js";
import type { LightExecution, NormalizedLightState } from "../types.js";
import type { LightResourceRegistry } from "../resources/registry.js";
import type { DurableTelemetryQueue } from "./durable-queue.js";
import { executionProgressEvent, resourceEvents } from "./event-builder.js";

export interface TelemetryService {
  resourceObserved(state: NormalizedLightState): Promise<void>;
  executionProgress(execution: LightExecution, state?: NormalizedLightState): Promise<void>;
}

interface TelemetryGrpcClient extends grpc.Client {
  emitProviderEvents(
    request: Record<string, unknown>,
    callback: (error: grpc.ServiceError | null, response: unknown) => void,
  ): grpc.ClientUnaryCall;
}

export interface TelemetryClientOptions {
  providerId: string;
  endpoint: string;
  enabled: boolean;
  tlsMode: "disabled" | "required";
  caPath?: string;
  certPath?: string;
  keyPath?: string;
}

export class ProviderTelemetryClient implements TelemetryService {
  readonly #client: TelemetryGrpcClient | undefined;
  #timer: NodeJS.Timeout | undefined;
  constructor(
    readonly options: TelemetryClientOptions,
    readonly registry: LightResourceRegistry,
    readonly queue: DurableTelemetryQueue,
  ) {
    if (options.enabled) {
      const Client = telemetryClientConstructor();
      this.#client = new Client(
        options.endpoint,
        credentials(options),
      ) as unknown as TelemetryGrpcClient;
    }
  }
  async resourceObserved(state: NormalizedLightState): Promise<void> {
    const resource = this.registry.require(state.resourceId);
    for (const event of resourceEvents(this.options.providerId, resource.entityId, state))
      this.queue.enqueue(event);
    await this.flush();
  }
  async executionProgress(execution: LightExecution, state?: NormalizedLightState): Promise<void> {
    this.queue.enqueue(
      executionProgressEvent(this.options.providerId, execution.entityId, execution, state),
    );
    await this.flush();
  }
  start(): void {
    if (this.#client !== undefined && this.#timer === undefined)
      this.#timer = setInterval(() => {
        void this.flush();
      }, 1000);
  }
  stop(): void {
    if (this.#timer !== undefined) clearInterval(this.#timer);
    this.#timer = undefined;
    this.#client?.close();
  }
  async flush(): Promise<void> {
    if (this.#client === undefined) return;
    const queued = this.queue.ready();
    if (queued.length === 0) return;
    const ids = new Set(queued.map((item) => item.event.providerEventId));
    try {
      const response = await new Promise<unknown>((resolve, reject) =>
        this.#client?.emitProviderEvents(
          { providerId: this.options.providerId, events: queued.map((item) => item.event) },
          (error, value) => (error === null ? resolve(value) : reject(error)),
        ),
      );
      const accepted = acceptedIds(response);
      this.queue.acknowledge(accepted);
      this.queue.failed(new Set([...ids].filter((id) => !accepted.has(id))));
    } catch {
      this.queue.failed(ids);
    }
  }
}

export class NoopTelemetryService implements TelemetryService {
  resourceObserved(): Promise<void> {
    return Promise.resolve();
  }
  executionProgress(): Promise<void> {
    return Promise.resolve();
  }
}

function credentials(options: TelemetryClientOptions): grpc.ChannelCredentials {
  if (options.tlsMode === "disabled") return grpc.credentials.createInsecure();
  if (
    options.caPath === undefined ||
    options.certPath === undefined ||
    options.keyPath === undefined
  )
    throw new Error("PROVIDER_TELEMETRY_MTLS_FILES_REQUIRED");
  return grpc.credentials.createSsl(
    readFileSync(options.caPath),
    readFileSync(options.keyPath),
    readFileSync(options.certPath),
  );
}
function acceptedIds(value: unknown): Set<string> {
  if (
    typeof value !== "object" ||
    value === null ||
    !("results" in value) ||
    !Array.isArray(value.results)
  )
    return new Set();
  const results: unknown[] = value.results;
  return new Set(results.filter(isAcceptedResult).map((result) => result.providerEventId));
}

function isAcceptedResult(value: unknown): value is { providerEventId: string } {
  if (typeof value !== "object" || value === null) return false;
  const result = value as Record<string, unknown>;
  return (
    (result.accepted === true || result.duplicate === true) &&
    typeof result.providerEventId === "string"
  );
}
