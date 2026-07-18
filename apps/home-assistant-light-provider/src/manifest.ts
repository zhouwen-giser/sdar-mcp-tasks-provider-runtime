import {
  ADAPTER_PROTOCOL_VERSION,
  jsonToProtoStruct,
} from "../../../packages/adapter-protocol/src/index.js";

const resourceId = { type: "string", minLength: 1, maxLength: 128 };
const capabilities = (scheduling: boolean, observations: boolean) => ({
  availability: true,
  scheduling,
  maxElapsed: false,
  cancel: false,
  pauseResume: false,
  inputRequired: false,
  idempotency: true,
  observations,
});
const binding = { mode: "ARGUMENT_REFERENCE", resourceIdJsonPointer: "/resourceId" };

export function providerManifest(
  providerId: string,
  providerVersion: string,
): Record<string, unknown> {
  return {
    adapterProtocolVersion: ADAPTER_PROTOCOL_VERSION,
    providerId,
    providerType: "home_assistant.light",
    providerVersion,
    inventoryMode: "RUNTIME_VISIBLE",
    operations: [
      {
        name: "light_get_state",
        description: "Read the current normalized state of a configured Home Assistant light.",
        execution: "SYNCHRONOUS",
        inputSchema: jsonToProtoStruct({
          type: "object",
          properties: { resourceId },
          required: ["resourceId"],
          additionalProperties: false,
        }),
        outputSchema: jsonToProtoStruct({
          type: "object",
          properties: {
            resourceId: { type: "string" },
            power: { type: "string", enum: ["on", "off", "unknown", "unavailable"] },
            reachable: { type: "boolean" },
            brightnessPercent: { type: ["integer", "null"], minimum: 1, maximum: 100 },
            observedAt: { type: "string", format: "date-time" },
          },
          required: ["resourceId", "power", "reachable", "brightnessPercent", "observedAt"],
          additionalProperties: false,
        }),
        capabilities: capabilities(false, false),
        resourceBinding: binding,
      },
      {
        name: "light_set_power",
        description: "Set and confirm power for a configured Home Assistant light.",
        execution: "TASK_REQUIRED",
        inputSchema: jsonToProtoStruct({
          type: "object",
          properties: { resourceId, power: { type: "string", enum: ["on", "off"] } },
          required: ["resourceId", "power"],
          additionalProperties: false,
        }),
        outputSchema: jsonToProtoStruct({
          type: "object",
          properties: {
            resourceId: { type: "string" },
            power: { type: "string", enum: ["on", "off"] },
            confirmed: { type: "boolean", const: true },
            observedAt: { type: "string", format: "date-time" },
          },
          required: ["resourceId", "power", "confirmed", "observedAt"],
          additionalProperties: false,
        }),
        capabilities: capabilities(true, true),
        resourceBinding: binding,
      },
      {
        name: "light_set_brightness",
        description: "Set and confirm brightness for a configured Home Assistant light.",
        execution: "TASK_REQUIRED",
        inputSchema: jsonToProtoStruct({
          type: "object",
          properties: {
            resourceId,
            brightnessPercent: { type: "integer", minimum: 1, maximum: 100 },
          },
          required: ["resourceId", "brightnessPercent"],
          additionalProperties: false,
        }),
        outputSchema: jsonToProtoStruct({
          type: "object",
          properties: {
            resourceId: { type: "string" },
            power: { type: "string", const: "on" },
            brightnessPercent: { type: "integer", minimum: 1, maximum: 100 },
            confirmed: { type: "boolean", const: true },
            observedAt: { type: "string", format: "date-time" },
          },
          required: ["resourceId", "power", "brightnessPercent", "confirmed", "observedAt"],
          additionalProperties: false,
        }),
        capabilities: capabilities(true, true),
        resourceBinding: binding,
      },
    ],
  };
}
