import * as grpc from "@grpc/grpc-js";
import {
  businessEventReasonFromError,
  protoStructToJson,
  type AdapterBusinessEvent,
  type GrpcAdapterGateway,
} from "../../../../packages/adapter-protocol/src/index.js";
import type {
  BusinessEventRepository,
  BusinessEventDeliverySemantics,
  BusinessEventLease,
  BusinessEventSourceFact,
} from "../../../../packages/persistence-postgres/src/index.js";

export interface AdapterBusinessEventSourceClientOptions {
  providerId: string;
  sourceId: string;
  sourceStreamId: string;
  deliverySemantics: BusinessEventDeliverySemantics;
  replicaId: string;
  leaseMs?: number;
  inboxRetentionMs?: number;
  eventRetentionMs?: number;
  mappingDeadlineMs?: number;
  generationRetentionMs?: number;
  metrics?: {
    increment(name: string, labels?: Record<string, string>, amount?: number): void;
    gauge(name: string, value: number, labels?: Record<string, string>): void;
  };
}

export class AdapterBusinessEventSourceClient {
  readonly #leaseMs: number;
  readonly #inboxRetentionMs: number;
  readonly #eventRetentionMs: number;
  readonly #mappingDeadlineMs: number;
  readonly #generationRetentionMs: number;

  constructor(
    readonly repository: BusinessEventRepository,
    readonly gateway: GrpcAdapterGateway,
    readonly options: AdapterBusinessEventSourceClientOptions,
  ) {
    this.#leaseMs = options.leaseMs ?? 30_000;
    this.#inboxRetentionMs = options.inboxRetentionMs ?? 604_800_000;
    this.#eventRetentionMs = options.eventRetentionMs ?? 604_800_000;
    this.#mappingDeadlineMs = options.mappingDeadlineMs ?? 60_000;
    this.#generationRetentionMs = options.generationRetentionMs ?? 604_800_000;
  }

  async runOnce(): Promise<"not_owner" | "completed" | "rotated" | "degraded"> {
    const lease = await this.repository.acquireSourceLease(
      this.options.providerId,
      this.options.sourceId,
      this.options.sourceStreamId,
      this.options.replicaId,
      this.#leaseMs,
    );
    if (lease === undefined) return "not_owner";
    const stream = this.gateway.streamBusinessEvents({
      sourceId: this.options.sourceId,
      sourceStreamId: this.options.sourceStreamId,
      ...(this.options.deliverySemantics === "durable_at_least_once" &&
      lease.lastPersistedSourceSequence !== "0"
        ? { afterSourceSequence: lease.lastPersistedSourceSequence }
        : {}),
    });
    try {
      await consumeStream(stream, async (event) => this.#handleEvent(lease, event));
      return "completed";
    } catch (error) {
      if (isServiceError(error)) {
        const reason = businessEventReasonFromError(error) ?? "SOURCE_TEMPORARILY_UNAVAILABLE";
        if (
          this.options.deliverySemantics === "durable_at_least_once" &&
          [
            "SOURCE_CURSOR_EXPIRED",
            "SOURCE_STREAM_RESET",
            "SOURCE_CURSOR_AHEAD",
            "SOURCE_DATA_LOSS",
          ].includes(reason)
        ) {
          await this.repository.rotateStream(
            this.options.providerId,
            reason,
            [this.options.sourceId],
            `${this.options.sourceStreamId}:${reason}:${lease.lastPersistedSourceSequence}`,
            this.#generationRetentionMs,
          );
          this.#increment("sdar_business_event_stream_rotations_total", { reason });
          this.#increment("sdar_business_event_continuity_loss_total", { reason });
          return "rotated";
        }
        await this.repository.markSourceUnavailable(lease, reason);
        this.#increment("sdar_business_event_source_blocked_total", {
          sourceId: this.options.sourceId,
          reason,
        });
        return "degraded";
      }
      throw error;
    }
  }

  async #handleEvent(lease: BusinessEventLease, event: AdapterBusinessEvent): Promise<void> {
    const fact = normalizeAdapterEvent(event);
    const intake = await this.repository.intakeSourceFact(
      lease,
      fact,
      this.#inboxRetentionMs,
      this.#mappingDeadlineMs,
    );
    this.#increment("sdar_business_event_source_received_total", {
      sourceId: this.options.sourceId,
      outcome: intake.disposition,
    });
    if (intake.disposition === "duplicate") {
      this.#increment("sdar_business_event_source_duplicate_total", {
        sourceId: this.options.sourceId,
      });
      return;
    }
    if (intake.disposition === "rejected") {
      this.#increment("sdar_business_event_source_rejected_total", {
        sourceId: this.options.sourceId,
        reason: "poison_event",
      });
    }
    if (
      intake.disposition === "rejected" &&
      this.options.deliverySemantics === "durable_at_least_once"
    ) {
      await this.repository.rotateStream(
        this.options.providerId,
        "SOURCE_POISON_EVENT",
        [this.options.sourceId],
        `${this.options.sourceStreamId}:poison:${fact.sourceSequence}`,
        this.#generationRetentionMs,
      );
      this.#increment("sdar_business_event_stream_rotations_total", {
        reason: "SOURCE_POISON_EVENT",
      });
      this.#increment("sdar_business_event_continuity_loss_total", {
        reason: "SOURCE_POISON_EVENT",
      });
      return;
    }
    const prepared = await this.repository.prepareNextSourceEvent(
      this.options.providerId,
      this.options.sourceId,
    );
    if (prepared === "ready") {
      await this.repository.finalizeNextSourceEvent(
        this.options.providerId,
        this.options.sourceId,
        this.#eventRetentionMs,
      );
      this.#increment("sdar_business_event_finalized_total", {
        sourceId: this.options.sourceId,
        outcome: "finalized",
      });
    } else if (
      prepared === "terminal" &&
      this.options.deliverySemantics === "durable_at_least_once"
    ) {
      this.#increment("sdar_business_event_source_mapping_failed_total", {
        sourceId: this.options.sourceId,
      });
      await this.repository.rotateStream(
        this.options.providerId,
        "SOURCE_MAPPING_FAILED",
        [this.options.sourceId],
        `${this.options.sourceStreamId}:mapping:${fact.sourceSequence}`,
        this.#generationRetentionMs,
      );
      this.#increment("sdar_business_event_stream_rotations_total", {
        reason: "SOURCE_MAPPING_FAILED",
      });
      this.#increment("sdar_business_event_continuity_loss_total", {
        reason: "SOURCE_MAPPING_FAILED",
      });
    } else if (prepared === "pending") {
      this.#gauge("sdar_business_event_publication_barrier_waiting", 1, {
        sourceId: this.options.sourceId,
      });
    }
  }

  #increment(name: string, labels: Record<string, string> = {}): void {
    try {
      this.options.metrics?.increment(name, labels);
    } catch {
      // Telemetry is best effort and cannot alter source processing.
    }
  }

  #gauge(name: string, value: number, labels: Record<string, string> = {}): void {
    try {
      this.options.metrics?.gauge(name, value, labels);
    } catch {
      // Telemetry is best effort and cannot alter source processing.
    }
  }
}

function normalizeAdapterEvent(event: AdapterBusinessEvent): BusinessEventSourceFact {
  const occurredAt = timestampToRfc3339Nano(event.occurredAt);
  return {
    sourceEventId: event.sourceEventId,
    sourceSequence: event.sourceSequence,
    sourceStreamId: event.sourceStreamId,
    scope: event.scope,
    occurredAt,
    eventType: event.eventType,
    description: event.description,
    ...(event.externalExecutionId === undefined || event.externalExecutionId === ""
      ? {}
      : { externalExecutionId: event.externalExecutionId }),
    ...(event.resourceRef === undefined || event.resourceRef === ""
      ? {}
      : { resourceRef: event.resourceRef }),
    ...(event.severityHint === "" ? {} : { severityHint: event.severityHint }),
    ...(event.reasonCode === "" ? {} : { reasonCode: event.reasonCode }),
    rawPayload: protoStructToJson(event.rawPayload),
  };
}

function timestampToRfc3339Nano(timestamp: { seconds?: string; nanos?: number }): string {
  const seconds = BigInt(timestamp.seconds ?? "0");
  const base = new Date(Number(seconds) * 1_000).toISOString().slice(0, 19);
  const nanos = timestamp.nanos ?? 0;
  const fraction = nanos === 0 ? "" : `.${String(nanos).padStart(9, "0").replace(/0+$/, "")}`;
  return `${base}${fraction}Z`;
}

function consumeStream(
  stream: grpc.ClientReadableStream<AdapterBusinessEvent>,
  onEvent: (event: AdapterBusinessEvent) => Promise<void>,
): Promise<void> {
  return new Promise((resolve, reject) => {
    let chain = Promise.resolve();
    let ended = false;
    stream.on("data", (event: AdapterBusinessEvent) => {
      stream.pause();
      chain = chain
        .then(() => onEvent(event))
        .then(
          () => {
            stream.resume();
          },
          (error: unknown) => {
            stream.cancel();
            reject(error instanceof Error ? error : new Error(String(error)));
          },
        );
    });
    stream.on("error", (error: grpc.ServiceError) => {
      if (!ended && error.code !== grpc.status.CANCELLED) reject(error);
    });
    stream.on("end", () => {
      ended = true;
      void chain.then(resolve, reject);
    });
  });
}

function isServiceError(error: unknown): error is grpc.ServiceError {
  return (
    error instanceof Error &&
    "code" in error &&
    typeof (error as { code?: unknown }).code === "number" &&
    "metadata" in error
  );
}
