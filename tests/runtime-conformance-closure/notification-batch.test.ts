import { EventEmitter } from "node:events";
import { describe, expect, it, vi } from "vitest";
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

describe("Runtime notification batch polling", () => {
  it("R-018 loads 256 Tasks and their input requests through bounded batch queries", async () => {
    const taskIds = Array.from(
      { length: 256 },
      (_, index) => `00000000-0000-4000-8000-${String(index).padStart(12, "0")}`,
    );
    const getAuthorizedTasksByIds = vi
      .fn()
      .mockResolvedValue(taskIds.map((taskId) => snapshot(taskId)));
    const listInputRequestsByTaskIds = vi.fn().mockResolvedValue(new Map());
    const getFrozenTask = vi
      .fn()
      .mockImplementation((taskId: string) => Promise.resolve(snapshot(taskId)));
    const stream = new TaskNotificationStream(
      { getAuthorizedTasksByIds, listInputRequestsByTaskIds, getFrozenTask } as never,
      { pollIntervalMs: 5, batchSize: 256 } as never,
    );
    const response = new FakeResponse(257);

    await stream.listen(request(taskIds), response as never, authorization);

    expect(getAuthorizedTasksByIds).toHaveBeenCalledOnce();
    expect(listInputRequestsByTaskIds).toHaveBeenCalledOnce();
    expect(getFrozenTask).not.toHaveBeenCalled();
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
}

function request(taskIds: string[]): FrozenJsonRpcRequest {
  return {
    jsonrpc: "2.0",
    id: "batch",
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
