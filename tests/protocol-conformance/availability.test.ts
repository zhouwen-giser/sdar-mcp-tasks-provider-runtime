import { describe, expect, it } from "vitest";
import {
  parseFrozenAvailability,
  validateFrozenRequest,
} from "../../packages/mcp-protocol/src/index.js";

describe("frozen Availability envelope", () => {
  it("parses complete and partial arguments with RFC 6901 pointers", () => {
    const checks = parseFrozenAvailability(
      validateFrozenRequest(
        request([
          {
            requestId: "complete:1",
            operationName: "embodied.move",
            arguments: { state: "complete", value: { resourceId: "r1", target: {} } },
          },
          {
            requestId: "partial:2",
            operationName: "vehicle/patrol",
            arguments: {
              state: "partial",
              knownValue: { resourceId: "r2" },
              unresolvedPaths: ["/target", "/escaped~1path"],
            },
            timing: {
              start: {
                mode: "scheduled",
                scheduledAt: "2026-07-18T03:10:00.000Z",
                startToleranceMs: 30_000,
              },
              maxElapsedMs: null,
            },
          },
        ]),
      ),
    );
    expect(checks).toHaveLength(2);
    expect(checks[0]?.arguments).toEqual({
      state: "complete",
      value: { resourceId: "r1", target: {} },
    });
    expect(checks[1]?.arguments).toMatchObject({
      state: "partial",
      unresolvedPaths: ["/target", "/escaped~1path"],
    });
  });

  it("rejects duplicate IDs, malformed pointers and non-strict argument unions", () => {
    for (const checks of [
      [complete("same"), complete("same")],
      [
        {
          requestId: "partial",
          operationName: "op",
          arguments: {
            state: "partial",
            knownValue: {},
            unresolvedPaths: ["$.target"],
          },
        },
      ],
      [
        {
          requestId: "mixed",
          operationName: "op",
          arguments: { state: "complete", value: {}, unresolvedPaths: ["/target"] },
        },
      ],
    ]) {
      expect(() => parseFrozenAvailability(validateFrozenRequest(request(checks)))).toThrow();
    }
  });
});

function complete(requestId: string): Record<string, unknown> {
  return {
    requestId,
    operationName: "op",
    arguments: { state: "complete", value: {} },
  };
}

function request(checks: Record<string, unknown>[]): Record<string, unknown> {
  return {
    jsonrpc: "2.0",
    id: "availability-1",
    method: "io.sdar/taskExecution/checkAvailability",
    params: {
      profileVersion: "1.0",
      checks,
      _meta: {
        "io.modelcontextprotocol/protocolVersion": "2026-07-28",
        "io.modelcontextprotocol/clientInfo": { name: "sdar", version: "1.0.0" },
        "io.modelcontextprotocol/clientCapabilities": {},
      },
    },
  };
}
