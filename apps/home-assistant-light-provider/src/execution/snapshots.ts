import { jsonToProtoStruct } from "../../../../packages/adapter-protocol/src/index.js";
import type { LightExecution } from "../types.js";

export function executionSnapshot(execution: LightExecution): Record<string, unknown> {
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
    ...(execution.state === "SUCCEEDED" ? { result: jsonToProtoStruct(result(execution)) } : {}),
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
  if (execution.desiredState.type === "power")
    return {
      resourceId: execution.resourceId,
      power: execution.desiredState.power,
      confirmed: true,
      observedAt: execution.updatedAt,
    };
  return {
    resourceId: execution.resourceId,
    power: "on",
    brightnessPercent: execution.desiredState.brightnessPercent,
    confirmed: true,
    observedAt: execution.updatedAt,
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
