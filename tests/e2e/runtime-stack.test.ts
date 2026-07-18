import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import type { Transport } from "@modelcontextprotocol/sdk/shared/transport.js";
import { CreateTaskResultSchema } from "@modelcontextprotocol/sdk/types.js";
import type * as grpc from "@grpc/grpc-js";
import { Pool } from "pg";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { loadRuntimeConfig } from "../../apps/runtime/src/config.js";
import { createRuntime } from "../../apps/runtime/src/runtime.js";
import type { RuntimeApplication } from "../../apps/runtime/src/runtime.js";
import {
  bindMockAdapter,
  createMockAdapterServer,
} from "../../examples/mock-adapter-typescript/src/server.js";

const databaseUrl = process.env.TEST_DATABASE_URL;
if (databaseUrl === undefined) throw new Error("TEST_DATABASE_URL is required for E2E tests");

let adapter: grpc.Server;
let adapterPort: number;
let runtime: RuntimeApplication;
let client: Client;
let transport: StreamableHTTPClientTransport;
let runtimeUrl: URL;

beforeAll(async () => {
  const pool = new Pool({ connectionString: databaseUrl });
  await pool.query(`DROP TABLE IF EXISTS
    provider_ops_delivery, runtime_lease, outbox_event, idempotency_record, task_command, task_input_request,
    task_observation, provider_task, admission_intent, operation_snapshot,
    runtime_schema_migration CASCADE`);
  await pool.end();

  adapter = createMockAdapterServer({ providerId: "e2e-provider" });
  adapterPort = await bindMockAdapter(adapter, "127.0.0.1:0");
  runtime = createRuntime(
    loadRuntimeConfig({
      DATABASE_URL: databaseUrl,
      PROVIDER_ID: "e2e-provider",
      ADAPTER_ENDPOINT: `127.0.0.1:${String(adapterPort)}`,
      AUTH_MODE: "trusted_headers",
      LEGACY_MCP_ENABLED: "true",
      LOG_LEVEL: "warn",
      SCHEDULER_POLL_MS: "1000",
      RECOVERY_POLL_MS: "5000",
      ADAPTER_RPC_TIMEOUT_MS: "250",
      ADAPTER_HEALTH_POLL_MS: "100",
      ADAPTER_HEALTH_FAILURE_THRESHOLD: "1",
    }),
  );
  await runtime.initialize();
  await runtime.app.listen({ host: "127.0.0.1", port: 0 });
  const address = runtime.app.server.address();
  if (address === null || typeof address === "string") throw new Error("Runtime did not bind");
  runtimeUrl = new URL(`http://127.0.0.1:${String(address.port)}/mcp/legacy`);
  client = new Client({ name: "runtime-e2e", version: "1.0.0" });
  transport = clientTransport();
  await client.connect(transport as unknown as Transport);
});

afterAll(async () => {
  await client.close();
  await runtime.app.close();
  await new Promise<void>((resolve) => adapter.tryShutdown(() => resolve()));
});

describe("independently deployed Runtime stack", () => {
  it("serves the frozen protocol on the primary endpoint", async () => {
    const discovery = await frozenRequest("server/discover", {}, 1);
    expect(discovery.statusCode).toBe(200);
    expect(discovery.json()).toMatchObject({
      result: {
        supportedVersions: ["2026-07-28"],
        _meta: { "io.modelcontextprotocol/serverInfo": { version: "2.0.0-rc.1" } },
      },
    });

    const tools = await frozenRequest("tools/list", {}, 2);
    expect(tools.json()).toMatchObject({ result: { resultType: "complete" } });
    expect(
      tools.json<{ result: { tools: { name: string }[] } }>().result.tools.map((tool) => tool.name),
    ).toEqual(["echo_sync", "durable_task", "flex_task"]);

    const synchronous = await frozenRequest(
      "tools/call",
      { name: "echo_sync", arguments: { message: "frozen-primary" } },
      3,
      "echo_sync",
    );
    expect(synchronous.json()).toMatchObject({
      result: { resultType: "complete", structuredContent: { message: "frozen-primary" } },
    });

    const created = await frozenRequest(
      "tools/call",
      { name: "durable_task", arguments: { resourceId: "frozen-e2e-resource" } },
      4,
      "durable_task",
      { "io.sdar/taskExecution": { profileVersion: "1.0", idempotencyKey: "frozen-e2e" } },
    );
    const createdBody = created.json<{ result: { taskId: string; resultType: string } }>();
    expect(createdBody.result).toMatchObject({ resultType: "task" });
    const queried = await frozenRequest(
      "tasks/get",
      { taskId: createdBody.result.taskId },
      5,
      createdBody.result.taskId,
    );
    expect(queried.json()).toMatchObject({
      result: { resultType: "complete", taskId: createdBody.result.taskId, status: "working" },
    });

    const controller = new AbortController();
    try {
      const response = await fetch(new URL("/mcp", runtimeUrl), {
        method: "POST",
        signal: controller.signal,
        headers: {
          accept: "application/json, text/event-stream",
          "content-type": "application/json",
          "mcp-protocol-version": "2026-07-28",
          "mcp-method": "subscriptions/listen",
          "x-sdar-subject": "e2e-user",
          "x-sdar-tenant": "e2e-tenant",
        },
        body: JSON.stringify({
          jsonrpc: "2.0",
          id: "frozen-subscription",
          method: "subscriptions/listen",
          params: {
            notifications: { taskIds: [createdBody.result.taskId] },
            _meta: frozenMeta(),
          },
        }),
      });
      expect(response.status).toBe(200);
      expect(response.headers.get("content-type")).toContain("text/event-stream");
      const reader = response.body?.getReader();
      if (reader === undefined) throw new Error("Frozen SSE response body is unavailable");
      const first = await reader.read();
      const chunk: unknown = first.value;
      if (!(chunk instanceof Uint8Array)) throw new Error("Frozen SSE frame is unavailable");
      const frames = new TextDecoder().decode(chunk);
      expect(frames).toContain("notifications/subscriptions/acknowledged");
      expect(frames).toContain(createdBody.result.taskId);
    } finally {
      controller.abort();
    }
  });

  it("becomes ready and publishes the bounded Adapter catalog", async () => {
    const ready = await runtime.app.inject({ method: "GET", url: "/health/ready" });
    expect(ready.statusCode).toBe(200);
    expect(ready.json()).toMatchObject({ status: "ready" });
    const tools = await client.listTools();
    expect(tools.tools.map((tool) => tool.name)).toEqual([
      "echo_sync",
      "durable_task",
      "flex_task",
    ]);
  });

  it("executes synchronous and durable task lifecycles over Streamable HTTP", async () => {
    const synchronous = await client.callTool({
      name: "echo_sync",
      arguments: { message: "release-candidate" },
    });
    expect(synchronous).toMatchObject({
      isError: false,
      structuredContent: { message: "release-candidate" },
    });

    const created = await client.request(
      {
        method: "tools/call",
        params: {
          name: "durable_task",
          arguments: { resourceId: "e2e-resource" },
          _meta: { "io.sdar/taskExecution": { idempotencyKey: "e2e-release-key" } },
        },
      },
      CreateTaskResultSchema,
      { task: { ttl: 60_000 } },
    );
    expect(created.task.status).toBe("working");
    const completed = await client.experimental.tasks.getTask(created.task.taskId);
    expect(completed).toMatchObject({ status: "completed" });
  });

  it("T-046 serves repeated requests and multiple clients in explicit stateless mode", async () => {
    expect(transport.sessionId).toBeUndefined();
    await expect(client.listTools()).resolves.toHaveProperty("tools.length", 3);
    await expect(client.listTools()).resolves.toHaveProperty("tools.length", 3);

    const secondTransport = clientTransport();
    const secondClient = new Client({ name: "runtime-e2e-second", version: "1.0.0" });
    try {
      await secondClient.connect(secondTransport as unknown as Transport);
      expect(secondTransport.sessionId).toBeUndefined();
      await expect(secondClient.listTools()).resolves.toHaveProperty("tools.length", 3);
    } finally {
      await secondClient.close();
    }
  });

  it("T-041/T-042 attributes Adapter loss and automatically restores readiness", async () => {
    await shutdown(adapter);
    const unavailable = await waitForReadiness("failed");
    expect(unavailable.statusCode).toBe(503);
    expect(unavailable.json()).toMatchObject({
      status: "not_ready",
      dependencies: { database: "ready", adapter: "failed" },
    });
    expect((await runtime.app.inject({ method: "GET", url: "/health/live" })).statusCode).toBe(200);

    adapter = createMockAdapterServer({ providerId: "e2e-provider" });
    expect(await bindMockAdapter(adapter, `127.0.0.1:${String(adapterPort)}`)).toBe(adapterPort);
    const recovered = await waitForReadiness("ready");
    expect(recovered.statusCode).toBe(200);
    expect(recovered.json()).toMatchObject({
      status: "ready",
      dependencies: { database: "ready", adapter: "ready" },
    });
  });
});

function clientTransport(): StreamableHTTPClientTransport {
  return new StreamableHTTPClientTransport(runtimeUrl, {
    requestInit: {
      headers: { "x-sdar-subject": "e2e-user", "x-sdar-tenant": "e2e-tenant" },
    },
  });
}

function frozenRequest(
  method: string,
  params: Record<string, unknown>,
  id: number,
  name?: string,
  extraMeta: Record<string, unknown> = {},
) {
  return runtime.app.inject({
    method: "POST",
    url: "/mcp",
    headers: {
      accept: "application/json, text/event-stream",
      "content-type": "application/json",
      "mcp-protocol-version": "2026-07-28",
      "mcp-method": method,
      ...(name === undefined ? {} : { "mcp-name": name }),
      "x-sdar-subject": "e2e-user",
      "x-sdar-tenant": "e2e-tenant",
    },
    payload: {
      jsonrpc: "2.0",
      id,
      method,
      params: {
        ...params,
        _meta: {
          ...frozenMeta(),
          ...extraMeta,
        },
      },
    },
  });
}

function frozenMeta(): Record<string, unknown> {
  return {
    "io.modelcontextprotocol/protocolVersion": "2026-07-28",
    "io.modelcontextprotocol/clientInfo": { name: "frozen-e2e", version: "1.0.0" },
    "io.modelcontextprotocol/clientCapabilities": {
      extensions: { "io.modelcontextprotocol/tasks": {} },
    },
  };
}

async function waitForReadiness(adapterStatus: "ready" | "failed") {
  const deadline = Date.now() + 5_000;
  for (;;) {
    const response = await runtime.app.inject({ method: "GET", url: "/health/ready" });
    const body = response.json<{ dependencies?: { adapter?: unknown } }>();
    if (body.dependencies?.adapter === adapterStatus) return response;
    if (Date.now() >= deadline) throw new Error(`Adapter did not become ${adapterStatus}`);
    await new Promise((resolve) => setTimeout(resolve, 50));
  }
}

function shutdown(server: grpc.Server): Promise<void> {
  return new Promise((resolve) => server.tryShutdown(() => resolve()));
}
