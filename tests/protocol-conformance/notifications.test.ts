import { EventEmitter } from "node:events";
import type { ServerResponse } from "node:http";
import { describe, expect, it } from "vitest";
import type { AuthorizationContext } from "../../packages/domain/src/index.js";
import { TaskNotFoundOrUnauthorizedError } from "../../packages/domain/src/index.js";
import {
  TaskNotificationStream,
  type FrozenJsonRpcRequest,
} from "../../packages/mcp-protocol/src/index.js";

const authorization: AuthorizationContext = {
  hash: "a".repeat(64),
  executionMode: "live",
  simulationId: null,
};

describe("frozen Task notification SSE", () => {
  it("sends the authorization-filtered stable Ack first, then the complete snapshot", async () => {
    const stream = new TaskNotificationStream({
      getFrozenTask: (taskId) => {
        if (taskId === "unknown") return Promise.reject(new TaskNotFoundOrUnauthorizedError());
        return Promise.resolve(snapshot(taskId, "1", "working"));
      },
    });
    const response = new FakeSseResponse(2);
    await stream.listen(
      request(["task-b", "unknown", "task-a", "task-b"]),
      response as unknown as ServerResponse,
      authorization,
    );

    expect(response.headers["content-type"]).toBe("text/event-stream");
    const messages = response.messages();
    expect(messages[0]).toMatchObject({
      method: "notifications/subscriptions/acknowledged",
      params: { notifications: { taskIds: ["task-a", "task-b"] } },
    });
    expect(messages[1]).toMatchObject({
      method: "notifications/tasks",
      params: {
        taskId: "task-a",
        _meta: {
          "io.modelcontextprotocol/subscriptionId": "subscription-1",
          "io.sdar/taskExecution": { runtimeRevision: "1", eventId: "task-a:1" },
        },
      },
    });
  });

  it("lets two Runtime replicas observe the same committed revision without regression", async () => {
    let revision = "1";
    const reader = {
      getFrozenTask: (taskId: string) => Promise.resolve(snapshot(taskId, revision, "working")),
    };
    const first = new FakeSseResponse(3);
    const second = new FakeSseResponse(3);
    const streams = [
      new TaskNotificationStream(reader, { pollIntervalMs: 5 }).listen(
        request(["task-a"]),
        first as unknown as ServerResponse,
        authorization,
      ),
      new TaskNotificationStream(reader, { pollIntervalMs: 5 }).listen(
        request(["task-a"]),
        second as unknown as ServerResponse,
        authorization,
      ),
    ];
    setTimeout(() => {
      revision = "2";
    }, 10);
    await Promise.all(streams);
    for (const response of [first, second]) {
      expect(
        response
          .messages()
          .filter((message) => message.method === "notifications/tasks")
          .map((message) =>
            String(
              (
                (message.params as Record<string, unknown>)._meta as Record<
                  string,
                  Record<string, unknown>
                >
              )["io.sdar/taskExecution"]?.runtimeRevision,
            ),
          ),
      ).toEqual(["1", "2"]);
    }
  });
});

class FakeSseResponse extends EventEmitter {
  readonly headers: Record<string, string> = {};
  readonly frames: string[] = [];
  statusCode = 0;

  constructor(readonly closeAfterFrames: number) {
    super();
  }

  setHeader(name: string, value: string): void {
    this.headers[name] = value;
  }

  flushHeaders(): void {
    return undefined;
  }

  write(frame: string): boolean {
    this.frames.push(frame);
    if (this.frames.length >= this.closeAfterFrames) setImmediate(() => this.emit("close"));
    return true;
  }

  end(): void {
    setImmediate(() => this.emit("close"));
  }

  messages(): Record<string, unknown>[] {
    return this.frames.map((frame) => {
      const value: unknown = JSON.parse(frame.split("data: ")[1]?.trim() ?? "null");
      if (typeof value !== "object" || value === null || Array.isArray(value)) {
        throw new Error("INVALID_TEST_SSE_FRAME");
      }
      return value as Record<string, unknown>;
    });
  }
}

function request(taskIds: string[]): FrozenJsonRpcRequest {
  return {
    jsonrpc: "2.0",
    id: "subscription-1",
    method: "subscriptions/listen",
    params: { notifications: { taskIds }, _meta: {} },
    meta: {
      protocolVersion: "2026-07-28",
      clientInfo: { name: "sdar", version: "1.0.0" },
      clientCapabilities: { extensions: { "io.modelcontextprotocol/tasks": {} } },
      raw: {},
    },
  };
}

function snapshot(taskId: string, revision: string, status: string): Record<string, unknown> {
  return {
    taskId,
    status,
    createdAt: "2026-07-18T03:00:00.000Z",
    lastUpdatedAt: "2026-07-18T03:01:00.000Z",
    ttlMs: 3_600_000,
    _meta: {
      "io.sdar/taskExecution": { profileVersion: "1.0", runtimeRevision: revision },
    },
  };
}
