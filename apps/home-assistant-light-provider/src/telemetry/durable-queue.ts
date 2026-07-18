import type { ProviderTelemetryEventInput } from "../../../../packages/provider-telemetry/src/index.js";
import type { ExecutionStore } from "../execution/execution-store.js";

export interface QueuedTelemetryEvent {
  event: ProviderTelemetryEventInput;
  attempts: number;
  nextAttemptAt: number;
}

export class DurableTelemetryQueue {
  constructor(
    readonly store: ExecutionStore,
    readonly maxSize = 1000,
  ) {}
  enqueue(event: Omit<ProviderTelemetryEventInput, "providerEventSequence">): void {
    this.store.updateDocument((document) => {
      const complete = {
        ...event,
        providerEventSequence: String(document.nextTelemetrySequence++),
      };
      const metricKey =
        complete.eventType === "RESOURCE_METRIC"
          ? `${complete.resourceId}:${String(complete.payload.metricName)}`
          : undefined;
      if (metricKey !== undefined) {
        const index = document.pendingTelemetryEvents.findIndex(
          (queued) =>
            queued.event.eventType === "RESOURCE_METRIC" &&
            `${queued.event.resourceId}:${String(queued.event.payload.metricName)}` === metricKey,
        );
        if (index >= 0) document.pendingTelemetryEvents.splice(index, 1);
      }
      document.pendingTelemetryEvents.push({ event: complete, attempts: 0, nextAttemptAt: 0 });
      while (document.pendingTelemetryEvents.length > this.maxSize) {
        const metric = document.pendingTelemetryEvents.findIndex(
          (queued) => queued.event.eventType === "RESOURCE_METRIC",
        );
        document.pendingTelemetryEvents.splice(metric >= 0 ? metric : 0, 1);
      }
    });
  }
  ready(now = Date.now(), limit = 100): QueuedTelemetryEvent[] {
    return this.store
      .readDocument()
      .pendingTelemetryEvents.filter((item) => item.nextAttemptAt <= now)
      .slice(0, limit);
  }
  acknowledge(ids: Set<string>): void {
    this.store.updateDocument((document) => {
      document.pendingTelemetryEvents = document.pendingTelemetryEvents.filter(
        (item) => !ids.has(item.event.providerEventId),
      );
    });
  }
  failed(ids: Set<string>, now = Date.now()): void {
    this.store.updateDocument((document) => {
      for (const item of document.pendingTelemetryEvents)
        if (ids.has(item.event.providerEventId)) {
          item.attempts += 1;
          item.nextAttemptAt = now + Math.min(30_000, 500 * 2 ** Math.min(item.attempts, 6));
        }
    });
  }
  size(): number {
    return this.store.readDocument().pendingTelemetryEvents.length;
  }
}
