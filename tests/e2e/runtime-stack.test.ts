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
let runtime: RuntimeApplication;
let client: Client;

beforeAll(async () => {
  const pool = new Pool({ connectionString: databaseUrl });
  await pool.query(`DROP TABLE IF EXISTS
    runtime_lease, outbox_event, idempotency_record, task_command, task_input_request,
    task_observation, provider_task, admission_intent, operation_snapshot,
    runtime_schema_migration CASCADE`);
  await pool.end();

  adapter = createMockAdapterServer({ providerId: "e2e-provider" });
  const adapterPort = await bindMockAdapter(adapter, "127.0.0.1:0");
  runtime = createRuntime(
    loadRuntimeConfig({
      DATABASE_URL: databaseUrl,
      PROVIDER_ID: "e2e-provider",
      ADAPTER_ENDPOINT: `127.0.0.1:${String(adapterPort)}`,
      AUTH_MODE: "trusted_headers",
      LOG_LEVEL: "warn",
      SCHEDULER_POLL_MS: "1000",
      RECOVERY_POLL_MS: "5000",
    }),
  );
  await runtime.initialize();
  await runtime.app.listen({ host: "127.0.0.1", port: 0 });
  const address = runtime.app.server.address();
  if (address === null || typeof address === "string") throw new Error("Runtime did not bind");
  client = new Client({ name: "runtime-e2e", version: "1.0.0" });
  await client.connect(
    new StreamableHTTPClientTransport(new URL(`http://127.0.0.1:${String(address.port)}/mcp`), {
      requestInit: {
        headers: { "x-sdar-subject": "e2e-user", "x-sdar-tenant": "e2e-tenant" },
      },
    }) as unknown as Transport,
  );
});

afterAll(async () => {
  await client.close();
  await runtime.app.close();
  await new Promise<void>((resolve) => adapter.tryShutdown(() => resolve()));
});

describe("independently deployed Runtime stack", () => {
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
});
