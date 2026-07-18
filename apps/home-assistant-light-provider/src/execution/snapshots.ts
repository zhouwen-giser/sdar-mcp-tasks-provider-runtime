import { jsonToProtoStruct } from "../../../../packages/adapter-protocol/src/index.js";
import type { LightExecution } from "../types.js";

export function executionSnapshot(execution: LightExecution): Record<string, unknown> {
  const completedResult = execution.state === "SUCCEEDED" ? result(execution) : undefined;
  return {
    taskId: execution.taskId,
    externalExecutionId: execution.externalExecutionId,
    operationName: execution.operationName,
    argumentHash: execution.argumentHash,
    executionContext: execution.executionContext,
    state: adapterState(execution.state),
    revision: String(execution.revision),
    reasonCode: reasonCode(execution.state),
    message: message(execution.state),
    ...(execution.state === "CONFIRMING" ? { progress: progress(execution) } : {}),
    ...(completedResult === undefined
      ? {}
      : {
          result: jsonToProtoStruct(completedResult),
          evidence: [completionEvidence(execution)],
        }),
    retryable: execution.state === "TECHNICAL_FAILED",
    observedAt: timestamp(new Date(execution.updatedAt)),
  };
}

export function advanceExecution(
  execution: LightExecution,
  state: LightExecution["state"],
  now = new Date(),
): LightExecution {
  if (execution.state === "SUCCEEDED" || execution.state === "TECHNICAL_FAILED") return execution;
  const updated = {
    ...execution,
    state,
    revision: execution.revision + 1,
    updatedAt: now.toISOString(),
  };
  updated.lastSnapshot = executionSnapshot(updated);
  return updated;
}

function adapterState(state: LightExecution["state"]): string {
  if (state === "PENDING_SIDE_EFFECT") return "ACCEPTED";
  if (state === "CONFIRMING") return "RUNNING";
  return state;
}
function reasonCode(state: LightExecution["state"]): string {
  if (state === "PENDING_SIDE_EFFECT") return "EXECUTION_PERSISTED";
  if (state === "CONFIRMING") return "HOME_ASSISTANT_CONFIRMING";
  if (state === "SUCCEEDED") return "HOME_ASSISTANT_STATE_CONFIRMED";
  return "HOME_ASSISTANT_STATE_CONFIRMATION_TIMEOUT";
}
function message(state: LightExecution["state"]): string {
  if (state === "PENDING_SIDE_EFFECT") return "Execution identity persisted.";
  if (state === "CONFIRMING") return "Waiting for observed Home Assistant state.";
  if (state === "SUCCEEDED") return "Desired light state confirmed.";
  return "Desired light state was not confirmed before the deadline.";
}
function result(execution: LightExecution): Record<string, unknown> {
  const confirmed = execution.confirmedState;
  if (confirmed === undefined) throw new Error("CONFIRMED_LIGHT_STATE_MISSING");
  if (execution.desiredState.type === "power")
    return {
      resourceId: execution.resourceId,
      power: confirmed.power,
      confirmed: true,
      observedAt: confirmed.observedAt,
    };
  return {
    resourceId: execution.resourceId,
    power: confirmed.power,
    brightnessPercent: confirmed.brightnessPercent,
    confirmed: true,
    observedAt: confirmed.observedAt,
  };
}

function completionEvidence(execution: LightExecution): Record<string, unknown> {
  const confirmed = execution.confirmedState;
  if (confirmed === undefined) throw new Error("CONFIRMED_LIGHT_STATE_MISSING");
  const brightness = execution.desiredState.type === "brightness";
  return {
    evidenceId: `home-assistant-light-${execution.taskId}-${String(execution.revision)}`,
    evidenceType: brightness ? "light.brightness.observation" : "light.state.observation",
    observedAt: confirmed.observedAt,
    subjectRef: `resource:${execution.resourceId}`,
    payloadRef: {
      kind: "structured_content",
      jsonPointer: brightness ? "/brightnessPercent" : "/power",
    },
    producer: ["home-assistant"],
  };
}
function progress(execution: LightExecution): Record<string, unknown> {
  if (execution.desiredState.type === "brightness")
    return {
      current: 0,
      total: execution.desiredState.brightnessPercent,
      percentage: 0,
      unit: "brightness_percent",
    };
  return { current: 0, total: 1, percentage: 0, unit: "confirmation" };
}
export function timestamp(value: Date): { seconds: string; nanos: number } {
  const ms = value.getTime();
  return { seconds: String(Math.floor(ms / 1000)), nanos: (ms % 1000) * 1_000_000 };
}
