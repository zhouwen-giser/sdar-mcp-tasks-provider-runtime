import { describe, expect, it } from "vitest";
import { jsonToProtoStruct } from "../../packages/adapter-protocol/src/index.js";
import type { ProviderManifest } from "../../packages/adapter-protocol/src/index.js";
import { Sep2663ProtocolHandler } from "../../packages/mcp-protocol/src/index.js";
import { OperationRegistry } from "../../packages/operation-registry/src/index.js";

describe("frozen tools/list", () => {
  it("publishes taskBehavior and no legacy execution fields", () => {
    const handler = new Sep2663ProtocolHandler(
      new OperationRegistry().validate(manifest("embodied.move", "TASK_REQUIRED")),
    );
    const response = handler.dispatch(request("tools/list"), headers("tools/list"));
    expect(response.httpStatus).toBe(200);
    expect(response.body).toMatchObject({
      result: {
        resultType: "complete",
        tools: [
          {
            name: "embodied.move",
            _meta: {
              "io.sdar/taskExecution": {
                profileVersion: "1.0",
                taskBehavior: "task_required",
                idempotency: "server_managed",
              },
            },
          },
        ],
      },
    });
    const serialized = JSON.stringify(response.body);
    expect(serialized).not.toContain('"execution"');
    expect(serialized).not.toContain('"supportsCancel"');
    expect(serialized).not.toContain('"supportsIdempotency"');
  });

  it("returns frozen Method not found for legacy task methods", () => {
    const handler = new Sep2663ProtocolHandler(
      new OperationRegistry().validate(manifest("vehicle/patrol", "SYNCHRONOUS")),
    );
    for (const method of ["tasks/result", "tasks/list", "tasks/observations"]) {
      expect(handler.dispatch(request(method), headers(method))).toMatchObject({
        httpStatus: 404,
        body: { error: { code: -32601, message: "Method not found" } },
      });
    }
  });
});

function request(method: string): Record<string, unknown> {
  return {
    jsonrpc: "2.0",
    id: "request-1",
    method,
    params: {
      _meta: {
        "io.modelcontextprotocol/protocolVersion": "2026-07-28",
        "io.modelcontextprotocol/clientInfo": { name: "sdar", version: "1.0.0" },
        "io.modelcontextprotocol/clientCapabilities": {},
      },
    },
  };
}

function headers(method: string): Record<string, string> {
  return {
    accept: "application/json, text/event-stream",
    "content-type": "application/json",
    "mcp-protocol-version": "2026-07-28",
    "mcp-method": method,
  };
}

function manifest(name: string, execution: "SYNCHRONOUS" | "TASK_REQUIRED"): ProviderManifest {
  return {
    adapterProtocolVersion: "1.0",
    providerId: "test-provider",
    providerType: "test",
    providerVersion: "1.0.0",
    inventoryMode: "OPAQUE",
    operations: [
      {
        name,
        description: "Test operation",
        execution,
        inputSchema: jsonToProtoStruct({ type: "object" }),
        outputSchema: jsonToProtoStruct({ type: "object" }),
        capabilities: {
          availability: true,
          scheduling: execution !== "SYNCHRONOUS",
          maxElapsed: true,
          cancel: true,
          pauseResume: false,
          inputRequired: true,
          idempotency: true,
          observations: true,
        },
      },
    ],
  };
}
