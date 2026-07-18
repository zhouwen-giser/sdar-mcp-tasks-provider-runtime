import { randomUUID } from "node:crypto";
import type { HomeAssistantRestClient } from "../home-assistant/rest-client.js";
import { normalizeLightState, percentToHaBrightness } from "../home-assistant/state-normalizer.js";
import type { LightResourceRegistry } from "../resources/registry.js";
import type { ExecutionContextRecord, LightExecution, NormalizedLightState } from "../types.js";
import type { TelemetryService } from "../telemetry/client.js";
import type { ExecutionStore } from "./execution-store.js";
import { advanceExecution, executionSnapshot } from "./snapshots.js";
import { ProviderError } from "../errors.js";

export interface StartControlInput {
  taskId: string;
  operationName: "light_set_power" | "light_set_brightness";
  resourceId: string;
  power?: "on" | "off";
  brightnessPercent?: number;
  argumentHash: string;
  executionContext: ExecutionContextRecord;
}

export class LightExecutionEngine {
  constructor(
    readonly store: ExecutionStore,
    readonly registry: LightResourceRegistry,
    readonly rest: HomeAssistantRestClient,
    readonly telemetry: TelemetryService,
    readonly confirmationTimeoutMs: number,
  ) {}

  async start(input: StartControlInput): Promise<LightExecution> {
    const existing = this.store.get(input.taskId);
    if (existing !== undefined) {
      if (!sameIdentity(existing, input)) throw new ProviderError("TASK_IDENTITY_CONFLICT", false);
      return existing;
    }
    const resource = this.registry.require(input.resourceId);
    if (input.operationName === "light_set_brightness") {
      const observed = normalizeLightState(
        resource.resourceId,
        await this.rest.getState(resource.entityId),
      );
      if (!observed.supportsBrightness) throw new ProviderError("BRIGHTNESS_NOT_SUPPORTED", false);
    }
    const now = new Date();
    const execution: LightExecution = {
      taskId: input.taskId,
      externalExecutionId: randomUUID(),
      operationName: input.operationName,
      resourceId: resource.resourceId,
      entityId: resource.entityId,
      argumentHash: input.argumentHash,
      executionContext: input.executionContext,
      desiredState:
        input.operationName === "light_set_power"
          ? { type: "power", power: input.power ?? "off" }
          : { type: "brightness", brightnessPercent: input.brightnessPercent ?? 1 },
      state: "PENDING_SIDE_EFFECT",
      sideEffectDispatched: false,
      revision: 1,
      createdAt: now.toISOString(),
      updatedAt: now.toISOString(),
      confirmationDeadlineAt: new Date(now.getTime() + this.confirmationTimeoutMs).toISOString(),
      lastSnapshot: {},
      commandAcks: {},
    };
    execution.lastSnapshot = executionSnapshot(execution);
    this.store.set(execution);
    await this.#dispatch(execution);
    return this.store.get(input.taskId) ?? execution;
  }

  async recover(): Promise<void> {
    for (const execution of this.store.list()) {
      if (execution.state === "PENDING_SIDE_EFFECT") await this.#dispatch(execution);
      else if (execution.state === "CONFIRMING") await this.poll(execution.taskId);
    }
  }

  async poll(taskId: string): Promise<void> {
    const execution = this.store.get(taskId);
    if (execution?.state !== "CONFIRMING") return;
    try {
      const state = normalizeLightState(
        execution.resourceId,
        await this.rest.getState(execution.entityId),
      );
      await this.observe(state);
    } catch {
      /* polling is best effort until the deadline */
    }
    const current = this.store.get(taskId);
    if (
      current?.state === "CONFIRMING" &&
      Date.now() >= Date.parse(current.confirmationDeadlineAt)
    ) {
      const failed = advanceExecution(current, "TECHNICAL_FAILED");
      this.store.set(failed);
    }
  }

  async observe(state: NormalizedLightState): Promise<void> {
    await this.telemetry.resourceObserved(state);
    for (const execution of this.store.list()) {
      if (
        execution.resourceId === state.resourceId &&
        execution.state === "CONFIRMING" &&
        confirmed(execution, state)
      ) {
        const succeeded = advanceExecution({ ...execution, confirmedState: state }, "SUCCEEDED");
        this.store.set(succeeded);
        await this.telemetry.executionProgress(succeeded, state);
      }
    }
  }

  async #dispatch(execution: LightExecution): Promise<void> {
    if (execution.sideEffectDispatched) return;
    const data: Record<string, unknown> = { entity_id: execution.entityId };
    const service =
      execution.desiredState.type === "power" && execution.desiredState.power === "off"
        ? "turn_off"
        : "turn_on";
    if (execution.desiredState.type === "brightness")
      data.brightness = percentToHaBrightness(execution.desiredState.brightnessPercent);
    await this.rest.callService("light", service, data);
    const confirming = advanceExecution({ ...execution, sideEffectDispatched: true }, "CONFIRMING");
    this.store.set(confirming);
    await this.telemetry.executionProgress(confirming);
  }
}

function confirmed(execution: LightExecution, state: NormalizedLightState): boolean {
  if (execution.desiredState.type === "power") return state.power === execution.desiredState.power;
  return (
    state.power === "on" &&
    state.brightnessPercent !== null &&
    Math.abs(state.brightnessPercent - execution.desiredState.brightnessPercent) <= 1
  );
}
function sameIdentity(execution: LightExecution, input: StartControlInput): boolean {
  return (
    execution.argumentHash === input.argumentHash &&
    execution.operationName === input.operationName &&
    execution.executionContext.authorizationContextHash ===
      input.executionContext.authorizationContextHash &&
    execution.executionContext.executionMode === input.executionContext.executionMode &&
    execution.executionContext.simulationId === input.executionContext.simulationId
  );
}
