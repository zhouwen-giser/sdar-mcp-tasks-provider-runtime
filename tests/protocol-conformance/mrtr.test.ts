import { describe, expect, it } from "vitest";
import { parseTaskInputResponses } from "../../packages/mcp-protocol/src/index.js";

describe("frozen MRTR inputResponses", () => {
  it("accepts the exact keyed elicitation response shape", () => {
    expect(
      parseTaskInputResponses({
        taskId: "task-1",
        inputResponses: {
          approval: { action: "accept", content: { approved: true } },
          optional: { action: "decline" },
        },
        _meta: {},
      }),
    ).toEqual({
      approval: { action: "accept", content: { approved: true } },
      optional: { action: "decline" },
    });
  });

  it.each([
    [{ taskId: "task-1", inputResponses: [], _meta: {} }, "INPUT_RESPONSES_INVALID"],
    [
      { taskId: "task-1", inputResponses: { approval: { action: "approve" } }, _meta: {} },
      "INPUT_RESPONSE_ACTION_INVALID",
    ],
    [
      {
        taskId: "task-1",
        inputResponses: { approval: { action: "accept", extra: true } },
        _meta: {},
      },
      "UNKNOWN_TASK_FIELD",
    ],
    [
      { taskId: "task-1", inputs: { approval: true }, inputResponses: {}, _meta: {} },
      "UNKNOWN_TASK_FIELD",
    ],
  ])("rejects non-frozen inputResponses", (params, code) => {
    expect(() => parseTaskInputResponses(params)).toThrow(code);
  });
});
