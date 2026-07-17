import {
  createProviderOpsEnvelope,
  type CanonicalJsonValue,
  type ProviderOpsEnvelope,
} from "../../observability/src/index.js";
import type { OutboxRecord } from "../../persistence-postgres/src/index.js";
import type { OutboxSink } from "./outbox-publisher.js";

const TASK_LIFECYCLE_EVENTS = new Set([
  "task.created",
  "task.accepted",
  "task.started",
  "task.progress",
  "task.paused",
  "task.resumed",
  "task.input_required",
  "task.input_answered",
  "task.completed",
  "task.failed",
  "task.cancelled",
  "task.cancel_requested",
  "task.deadline_stop_requested",
  "task.start_window_stop_requested",
  "task.start_window_violation",
  "task.expired",
]);

export interface ProviderOpsEventEmitter {
  emitEnvelope(envelope: ProviderOpsEnvelope): void;
}

export interface ProviderOpsOutboxContext {
  providerId: string;
  runtimeVersion: string;
  instanceId: string;
}

/** Publishes the product Outbox first, then derives best-effort telemetry from committed facts. */
export class ProviderOpsOutboxSink implements OutboxSink {
  constructor(
    readonly downstream: OutboxSink,
    readonly emitter: ProviderOpsEventEmitter,
    readonly context: ProviderOpsOutboxContext,
  ) {}

  async publish(events: OutboxRecord[]): Promise<void> {
    await this.downstream.publish(events);
    for (const event of events) {
      const envelope =
        lifecycleEnvelope(event, this.context) ?? commandEnvelope(event, this.context);
      if (envelope === null) continue;
      try {
        this.emitter.emitEnvelope(envelope);
      } catch {
        // Telemetry must never change Outbox delivery or Task lifecycle behavior.
      }
    }
  }
}

export function commandEnvelope(
  event: OutboxRecord,
  context: ProviderOpsOutboxContext,
): ProviderOpsEnvelope | null {
  if (!event.eventType.startsWith("task.command")) return null;
  const sequence = numericField(event.payload, "commandSequence");
  if (sequence === undefined) return null;
  const payload = allowlistedPayload(event.payload, [
    "commandType",
    "commandState",
    "attemptCount",
    "reasonCode",
  ]);
  return createProviderOpsEnvelope({
    recordType: "provider.command_dispatch",
    eventCategory: "command.dispatch",
    deliveryClass: "operational",
    providerId: context.providerId,
    runtimeVersion: context.runtimeVersion,
    instanceId: context.instanceId,
    taskId: event.aggregateId,
    ...optionalIdentityFields(event.payload),
    commandSequence: sequence,
    stableAggregateIdentity: event.aggregateId,
    eventIdentity: event.eventId,
    revision: sequence,
    occurredAt: event.createdAt,
    attributes: { source: "committed_outbox", commandEvent: event.eventType },
    payload,
  });
}

export function lifecycleEnvelope(
  event: OutboxRecord,
  context: ProviderOpsOutboxContext,
): ProviderOpsEnvelope | null {
  if (!TASK_LIFECYCLE_EVENTS.has(event.eventType)) return null;
  const payload = allowlistedLifecyclePayload(event.payload);
  const revision = numericField(event.payload, "observationRevision");
  return createProviderOpsEnvelope({
    recordType: "provider.task_lifecycle",
    eventCategory: "task.lifecycle",
    deliveryClass: "audit",
    providerId: context.providerId,
    runtimeVersion: context.runtimeVersion,
    instanceId: context.instanceId,
    taskId: event.aggregateId,
    ...optionalIdentityFields(event.payload),
    stableAggregateIdentity: event.aggregateId,
    eventIdentity: event.eventId,
    ...(revision === undefined ? {} : { revision, observationRevision: revision }),
    occurredAt: event.createdAt,
    attributes: { source: "committed_outbox", lifecycleEvent: event.eventType },
    payload,
  });
}

function allowlistedLifecyclePayload(
  payload: Record<string, unknown>,
): Record<string, CanonicalJsonValue> {
  return allowlistedPayload(payload, [
    "previousState",
    "currentState",
    "previousSubstate",
    "currentSubstate",
    "reasonCode",
    "observationRevision",
    "adapterRevision",
    "terminal",
    "resultClass",
  ]);
}

function optionalIdentityFields(payload: Record<string, unknown>): Partial<ProviderOpsEnvelope> {
  const fields: Partial<ProviderOpsEnvelope> = {};
  for (const key of [
    "externalExecutionId",
    "operationName",
    "executionMode",
    "simulationId",
    "argumentHash",
    "authorizationContextHash",
  ] as const) {
    const value = payload[key];
    if (typeof value === "string" && value.length > 0) fields[key] = value;
  }
  return fields;
}

function allowlistedPayload(
  payload: Record<string, unknown>,
  keys: readonly string[],
): Record<string, CanonicalJsonValue> {
  const result: Record<string, CanonicalJsonValue> = {};
  for (const key of keys) {
    const value = payload[key];
    if (value === null || typeof value === "string" || typeof value === "boolean") {
      result[key] = value;
    } else if (typeof value === "number" && Number.isFinite(value)) {
      result[key] = value;
    }
  }
  return result;
}

function numericField(payload: Record<string, unknown>, key: string): number | undefined {
  const value = payload[key];
  return typeof value === "number" && Number.isSafeInteger(value) ? value : undefined;
}
