export type LightPower = "on" | "off" | "unknown" | "unavailable";

export interface HomeAssistantState {
  entity_id: string;
  state: string;
  attributes: Record<string, unknown>;
  last_changed: string;
  last_updated: string;
}

export interface NormalizedLightState {
  resourceId: string;
  power: LightPower;
  reachable: boolean;
  brightnessPercent: number | null;
  observedAt: string;
  supportedColorModes: string[];
  supportsBrightness: boolean;
}

export interface LightResourceConfig {
  resourceId: string;
  entityId: string;
  displayName: string;
  enabled: boolean;
  expectedCapabilities: { power: boolean; brightness: boolean };
}

export type LightOperationName = "light_get_state" | "light_set_power" | "light_set_brightness";

export interface ExecutionContextRecord {
  authorizationContextHash: string;
  executionMode: string;
  simulationId: string;
  correlationId: string;
}

export interface LightExecution {
  taskId: string;
  externalExecutionId: string;
  operationName: Exclude<LightOperationName, "light_get_state">;
  resourceId: string;
  entityId: string;
  argumentHash: string;
  executionContext: ExecutionContextRecord;
  desiredState:
    { type: "power"; power: "on" | "off" } | { type: "brightness"; brightnessPercent: number };
  state: "PENDING_SIDE_EFFECT" | "CONFIRMING" | "SUCCEEDED" | "TECHNICAL_FAILED";
  sideEffectDispatched: boolean;
  revision: number;
  createdAt: string;
  updatedAt: string;
  confirmationDeadlineAt: string;
  confirmedState?: NormalizedLightState;
  lastSnapshot: Record<string, unknown>;
  commandAcks: Record<string, Record<string, unknown>>;
}
