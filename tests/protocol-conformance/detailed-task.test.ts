import { describe, expect, it } from "vitest";
import type { TaskRecord } from "../../packages/domain/src/index.js";
import { mapTaskToDetailedTask } from "../../packages/task-engine/src/index.js";

describe("frozen DetailedTask projection", () => {
  it("uses flat result types, true handle TTL, and the Runtime revision", () => {
    const task = fixture({
      mcpStatus: "completed",
      result: { content: [], structuredContent: { ok: true }, isError: false },
      handleExpiresAt: new Date("2026-07-18T04:00:00.000Z"),
    });

    const created = mapTaskToDetailedTask(task, [], "create");
    expect(created).toMatchObject({
      resultType: "task",
      taskId: "00000000-0000-4000-8000-000000000001",
      ttlMs: 3_600_000,
      result: { resultType: "complete", structuredContent: { ok: true } },
      _meta: {
        "io.sdar/taskExecution": { profileVersion: "1.0", runtimeRevision: "42" },
      },
    });
    expect(created).not.toHaveProperty("task");
    expect(created).not.toHaveProperty("ttl");
    expect(created).not.toHaveProperty("pollInterval");

    expect(mapTaskToDetailedTask(task, [], "get")).toMatchObject({ resultType: "complete" });
    expect(mapTaskToDetailedTask(task)).not.toHaveProperty("resultType");
  });

  it("maps open MRTR requests by stable request key", () => {
    const task = fixture({ mcpStatus: "input_required" });
    expect(
      mapTaskToDetailedTask(
        task,
        [
          {
            key: "approval-1",
            description: "Approve the movement?",
            schema: { type: "object", properties: { approved: { type: "boolean" } } },
            required: true,
            status: "OPEN",
            answerHash: null,
          },
          {
            key: "answered-1",
            description: "Already answered",
            schema: { type: "object" },
            required: true,
            status: "ANSWERED",
            answerHash: "a".repeat(64),
          },
        ],
        "get",
      ),
    ).toMatchObject({
      inputRequests: {
        "approval-1": {
          method: "elicitation/create",
          params: {
            mode: "form",
            message: "Approve the movement?",
            requestedSchema: { type: "object" },
          },
        },
      },
    });
  });

  it("uses null TTL when the handle has no expiry", () => {
    expect(mapTaskToDetailedTask(fixture({ handleExpiresAt: null }), [], "get")).toMatchObject({
      ttlMs: null,
    });
  });
});

function fixture(overrides: Partial<TaskRecord> = {}): TaskRecord {
  return {
    taskId: "00000000-0000-4000-8000-000000000001",
    mcpStatus: "working",
    statusMessage: "Working",
    createdAt: new Date("2026-07-18T03:00:00.000Z"),
    updatedAt: new Date("2026-07-18T03:01:30.000Z"),
    runtimeUpdatedAt: new Date("2026-07-18T03:01:00.000Z"),
    runtimeRevision: "42",
    handleExpiresAt: new Date("2026-07-18T04:00:00.000Z"),
    pollIntervalMs: 1_000,
    adapterRevision: 7,
    substate: "running",
    cancelRequested: false,
    result: null,
    error: null,
    ...overrides,
  } as TaskRecord;
}
