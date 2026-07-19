import { EventEmitter } from "node:events";
import { describe, expect, it } from "vitest";
import type { AuthorizationContext } from "../../packages/domain/src/index.js";
import {
  TaskNotificationStream,
  type FrozenJsonRpcRequest,
} from "../../packages/mcp-protocol/src/index.js";

const authorization: AuthorizationContext = {
  hash: "a".repeat(64),
  executionMode: "live",
  simulationId: null,
};

describe("Runtime notification capacity", () => {
  it("R-016 enforces the configured global subscription limit", async () => {
    const stream = new TaskNotificationStream(
      { getFrozenTask: (taskId) => Promise.resolve(snapshot(taskId)) },
      { pollIntervalMs: 5, maxSubscriptions: 1 } as never,
    );
    const first = new FakeResponse(Number.POSITIVE_INFINITY);
    const listening = stream.listen(request("first", ["task-a"]), first as never, authorization);
    await first.waitForFrames(2);
    try {
      await expect(
        stream.listen(request("second", ["task-b"]), new FakeResponse(2) as never, authorization),
      ).rejects.toMatchObject({
        code: -32603,
        httpStatus: 503,
        data: { reasonCode: "TASK_NOTIFICATION_CAPACITY_EXCEEDED", retryable: true },
      });
    } finally {
      stream.cancel("first");
      await listening;
    }
  });

  it("R-017 enforces the configured global Task binding limit", async () => {
    const stream = new TaskNotificationStream(
      { getFrozenTask: (taskId) => Promise.resolve(snapshot(taskId)) },
      { maxTaskBindings: 1 } as never,
    );
    await expect(
      stream.listen(
        request("too-many-bindings", ["task-a", "task-b"]),
        new FakeResponse(2) as never,
        authorization,
      ),
    ).rejects.toMatchObject({
      code: -32603,
      httpStatus: 503,
      data: { reasonCode: "TASK_NOTIFICATION_CAPACITY_EXCEEDED", retryable: true },
    });
  });

  it("waits for drain instead of closing a stream on Node backpressure", async () => {
    const stream = new TaskNotificationStream({
      getFrozenTask: (taskId) => Promise.resolve(snapshot(taskId)),
    });
    const response = new BackpressureResponse();
    await stream.listen(request("slow", ["task-a"]), response as never, authorization);
    expect(response.endedForBackpressure).toBe(false);
    expect(response.frames).toHaveLength(2);
  });
});

class FakeResponse extends EventEmitter {
  readonly frames: string[] = [];
  statusCode = 0;
  constructor(readonly closeAfterFrames: number) {
    super();
  }
  setHeader(): void {
    return undefined;
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
  async waitForFrames(count: number): Promise<void> {
    while (this.frames.length < count) await new Promise((resolve) => setTimeout(resolve, 1));
  }
}

class BackpressureResponse extends FakeResponse {
  endedForBackpressure = false;
  constructor() {
    super(Number.POSITIVE_INFINITY);
  }
  override write(frame: string): boolean {
    this.frames.push(frame);
    if (this.frames.length === 1) {
      setImmediate(() => this.emit("drain"));
      return false;
    }
    setImmediate(() => this.emit("close"));
    return true;
  }
  override end(): void {
    this.endedForBackpressure = true;
    super.end();
  }
}

function request(id: string, taskIds: string[]): FrozenJsonRpcRequest {
  return {
    jsonrpc: "2.0",
    id,
    method: "subscriptions/listen",
    params: { notifications: { taskIds }, _meta: {} },
    meta: {
      protocolVersion: "2026-07-28",
      clientInfo: { name: "closure", version: "1.0.0" },
      clientCapabilities: { extensions: { "io.modelcontextprotocol/tasks": {} } },
      raw: {},
    },
  };
}

function snapshot(taskId: string): Record<string, unknown> {
  return {
    taskId,
    status: "working",
    createdAt: "2026-07-19T00:00:00.000Z",
    lastUpdatedAt: "2026-07-19T00:00:01.000Z",
    ttlMs: 60_000,
    _meta: { "io.sdar/taskExecution": { profileVersion: "1.0", runtimeRevision: "1" } },
  };
}
