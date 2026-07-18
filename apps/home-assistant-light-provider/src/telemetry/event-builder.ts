import { createHash } from "node:crypto";
import type {
  ProviderTelemetryEventInput,
  ProviderTelemetryEventType,
} from "../../../../packages/provider-telemetry/src/index.js";
import type { LightExecution, NormalizedLightState } from "../types.js";
import { timestamp } from "../execution/snapshots.js";

export function stableProviderEventId(
  providerId: string,
  entityId: string,
  observedAt: string,
  eventType: string,
  payload: Record<string, unknown>,
): string {
  return createHash("sha256")
    .update(`${providerId}\n${entityId}\n${observedAt}\n${eventType}\n${canonicalJson(payload)}`)
    .digest("hex");
}

export function resourceEvents(
  providerId: string,
  entityId: string,
  state: NormalizedLightState,
): Omit<ProviderTelemetryEventInput, "providerEventSequence">[] {
  const health =
    state.power === "unavailable" ? "offline" : state.power === "unknown" ? "degraded" : "healthy";
  const statePayload = { state: state.power, reasonCode: "HOME_ASSISTANT_STATE_CHANGED" };
  const healthPayload = {
    health,
    reasonCode: state.reachable ? "HOME_ASSISTANT_REACHABLE" : "HOME_ASSISTANT_UNREACHABLE",
  };
  const events = [
    base(providerId, entityId, state, "RESOURCE_STATE", statePayload, {
      reachable: state.reachable,
    }),
    base(providerId, entityId, state, "RESOURCE_HEALTH", healthPayload, {}),
  ];
  if (state.brightnessPercent !== null) {
    const payload = {
      metricName: "brightness",
      value: state.brightnessPercent,
      unit: "percent",
      quality: "observed",
    };
    events.push(base(providerId, entityId, state, "RESOURCE_METRIC", payload, {}));
  }
  return events;
}

export function executionProgressEvent(
  providerId: string,
  entityId: string,
  execution: LightExecution,
  state?: NormalizedLightState,
): Omit<ProviderTelemetryEventInput, "providerEventSequence"> {
  const desired =
    execution.desiredState.type === "brightness" ? execution.desiredState.brightnessPercent : 1;
  const current =
    execution.state === "SUCCEEDED"
      ? desired
      : execution.desiredState.type === "brightness"
        ? (state?.brightnessPercent ?? 0)
        : 0;
  const payload = {
    current,
    total: desired,
    percentage: Math.round((current / desired) * 100),
    unit: execution.desiredState.type === "brightness" ? "brightness_percent" : "confirmation",
  };
  const eventType = "EXECUTION_PROGRESS" as const;
  return {
    providerEventId: stableProviderEventId(
      providerId,
      entityId,
      `${execution.taskId}:${String(execution.revision)}`,
      eventType,
      payload,
    ),
    eventType,
    resourceId: execution.resourceId,
    resourceType: "home_assistant.light",
    taskId: execution.taskId,
    externalExecutionId: execution.externalExecutionId,
    operationName: execution.operationName,
    occurredAt: timestamp(new Date(execution.updatedAt)),
    attributes: {},
    payload,
    traceparent: "",
    tracestate: "",
  };
}

function base(
  providerId: string,
  entityId: string,
  state: NormalizedLightState,
  eventType: ProviderTelemetryEventType,
  payload: Record<string, unknown>,
  attributes: Record<string, unknown>,
): Omit<ProviderTelemetryEventInput, "providerEventSequence"> {
  return {
    providerEventId: stableProviderEventId(
      providerId,
      entityId,
      state.observedAt,
      eventType,
      payload,
    ),
    eventType,
    resourceId: state.resourceId,
    resourceType: "home_assistant.light",
    taskId: "",
    externalExecutionId: "",
    operationName: "",
    occurredAt: timestamp(new Date(state.observedAt)),
    attributes,
    payload,
    traceparent: "",
    tracestate: "",
  };
}
function canonicalJson(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(",")}]`;
  if (typeof value === "object" && value !== null)
    return `{${Object.keys(value)
      .sort()
      .map(
        (key) => `${JSON.stringify(key)}:${canonicalJson((value as Record<string, unknown>)[key])}`,
      )
      .join(",")}}`;
  return JSON.stringify(value);
}
