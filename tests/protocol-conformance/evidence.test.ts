import { describe, expect, it } from "vitest";
import type { ExecutionSnapshot } from "../../packages/adapter-protocol/src/index.js";
import { attachEvidenceToResult } from "../../packages/task-engine/src/result-contract.js";

describe("frozen type-only Evidence", () => {
  it("maps validated Adapter Evidence without requirementId", () => {
    const result = attachEvidenceToResult(
      { content: [], structuredContent: { finalPosition: { x: 1, y: 2 } }, isError: false },
      snapshot([
        {
          evidenceId: "position-1",
          evidenceType: "position.observation",
          observedAt: "2026-07-18T03:12:00.000Z",
          subjectRef: "resource:UGV-001",
          payloadRef: { kind: "structured_content", jsonPointer: "/finalPosition" },
          producer: ["sensor:gps-1"],
          requirementId: "must-not-cross-wire-boundary",
        },
      ]),
      { finalPosition: { x: 1, y: 2 } },
    );
    expect(result).toMatchObject({
      resultType: "complete",
      _meta: {
        "io.sdar/evidence": {
          profileVersion: "1.0",
          items: [
            {
              evidenceId: "position-1",
              evidenceType: "position.observation",
              payloadRef: { kind: "structured_content", jsonPointer: "/finalPosition" },
            },
          ],
        },
      },
    });
    expect(JSON.stringify(result)).not.toContain("requirementId");
  });

  it.each([
    [
      [
        {
          evidenceId: "missing",
          evidenceType: "position.observation",
          observedAt: "2026-07-18T03:12:00Z",
          payloadRef: { kind: "structured_content", jsonPointer: "/missing" },
        },
      ],
      "ADAPTER_EVIDENCE_POINTER_MISSING",
    ],
    [
      [
        {
          evidenceId: "uri",
          evidenceType: "artifact",
          observedAt: "2026-07-18T03:12:00Z",
          payloadRef: { kind: "uri", uri: "file:///private/evidence.json" },
        },
      ],
      "ADAPTER_EVIDENCE_URI_INVALID",
    ],
    [
      [
        {
          evidenceId: "time",
          evidenceType: "artifact",
          observedAt: "2026-07-18T03:12:00",
          payloadRef: { kind: "uri", uri: "https://example.test/evidence.json" },
        },
      ],
      "ADAPTER_EVIDENCE_OBSERVED_AT_INVALID",
    ],
  ])("rejects invalid Evidence contracts", (items, code) => {
    expect(() => attachEvidenceToResult({}, snapshot(items), {})).toThrow(code);
  });
});

function snapshot(evidence: unknown[]): ExecutionSnapshot {
  return { evidence } as unknown as ExecutionSnapshot;
}
