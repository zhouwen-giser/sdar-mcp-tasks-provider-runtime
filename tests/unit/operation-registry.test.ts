import { describe, expect, it } from "vitest";
import { jsonToProtoStruct } from "../../packages/adapter-protocol/src/index.js";
import type { ProviderManifest } from "../../packages/adapter-protocol/src/index.js";
import { OperationRegistry } from "../../packages/operation-registry/src/index.js";

function manifest(): ProviderManifest {
  return {
    adapterProtocolVersion: "1.0",
    providerId: "test-provider",
    providerType: "test",
    providerVersion: "1.0.0",
    inventoryMode: "OPAQUE",
    operations: [
      {
        name: "echo_sync",
        description: "Echo",
        execution: "SYNCHRONOUS",
        inputSchema: jsonToProtoStruct({ type: "object", additionalProperties: false }),
        outputSchema: jsonToProtoStruct({ type: "object" }),
        capabilities: {
          availability: true,
          scheduling: false,
          maxElapsed: false,
          cancel: false,
          pauseResume: false,
          inputRequired: false,
          idempotency: true,
          observations: false,
        },
      },
    ],
  };
}

describe("Operation Registry", () => {
  it("normalizes schemas and emits stable Tool metadata/hash", () => {
    const registry = new OperationRegistry();
    const first = registry.validate(manifest());
    const second = registry.validate(manifest());
    expect(first.manifestHash).toBe(second.manifestHash);
    expect(first.operations[0]?.tool.name).toBe("echo_sync");
    expect(first.operations[0]?.tool._meta).toMatchObject({
      "io.sdar/taskExecution": { execution: "synchronous", supportsScheduling: false },
    });
  });

  it("rejects duplicate operations and synchronous scheduling", () => {
    const duplicate = manifest();
    const duplicateOperation = duplicate.operations[0];
    if (duplicateOperation === undefined) throw new Error("fixture operation missing");
    duplicate.operations.push(duplicateOperation);
    expect(() => new OperationRegistry().validate(duplicate)).toThrow("DUPLICATE_OPERATION_NAME");
    const invalid = manifest();
    const invalidOperation = invalid.operations[0];
    if (invalidOperation === undefined) throw new Error("fixture operation missing");
    invalidOperation.capabilities.scheduling = true;
    expect(() => new OperationRegistry().validate(invalid)).toThrow(
      "SYNCHRONOUS_SCHEDULING_CONFLICT",
    );
  });

  it("rejects excessive schema depth", () => {
    let schema: Record<string, unknown> = { type: "string" };
    for (let index = 0; index < 40; index += 1) schema = { allOf: [schema] };
    const invalid = manifest();
    const invalidOperation = invalid.operations[0];
    if (invalidOperation === undefined) throw new Error("fixture operation missing");
    invalidOperation.inputSchema = jsonToProtoStruct(schema);
    expect(() => new OperationRegistry().validate(invalid)).toThrow("MANIFEST_SCHEMA_TOO_DEEP");
  });
});
