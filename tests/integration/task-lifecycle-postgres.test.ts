import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import type { Transport } from "@modelcontextprotocol/sdk/shared/transport.js";
import { CreateTaskResultSchema } from "@modelcontextprotocol/sdk/types.js";
import Fastify from "fastify";
import type * as grpc from "@grpc/grpc-js";
import { Pool } from "pg";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import {
  bindMockAdapter,
  createMockAdapterServer,
} from "../../examples/mock-adapter-typescript/src/server.js";
import { GrpcAdapterGateway } from "../../packages/adapter-protocol/src/index.js";
import type { AuthorizationContext } from "../../packages/domain/src/index.js";
import { McpProtocolHandler } from "../../packages/mcp-protocol/src/index.js";
import { OperationRegistry } from "../../packages/operation-registry/src/index.js";
import {
  OperationSnapshotRepository,
  TaskRepository,
  runMigrations,
} from "../../packages/persistence-postgres/src/index.js";
import { TaskEngine } from "../../packages/task-engine/src/index.js";

const databaseUrl = process.env.TEST_DATABASE_URL;
if (databaseUrl === undefined)
  throw new Error("TEST_DATABASE_URL is required for PostgreSQL integration");

const pool = new Pool({ connectionString: databaseUrl, max: 5 });
const authorization: AuthorizationContext = {
  hash: "a".repeat(64),
  executionMode: "live",
  simulationId: null,
};
let adapter: grpc.Server;
let gateway: GrpcAdapterGateway;
let engine: TaskEngine;

beforeAll(async () => {
  await pool.query(`DROP TABLE IF EXISTS
    runtime_lease, outbox_event, idempotency_record, task_input_request,
    task_observation, provider_task, admission_intent, operation_snapshot,
    runtime_schema_migration CASCADE`);
  await runMigrations(pool);
  adapter = createMockAdapterServer({ providerId: "task-provider" });
  const port = await bindMockAdapter(adapter, "127.0.0.1:0");
  gateway = new GrpcAdapterGateway({
    endpoint: `127.0.0.1:${String(port)}`,
    providerId: "task-provider",
  });
  const manifest = new OperationRegistry().validate(await gateway.describeProvider());
  const snapshots = await new OperationSnapshotRepository(pool).saveManifest(manifest);
  engine = new TaskEngine(manifest, snapshots, gateway, new TaskRepository(pool));
});

afterAll(async () => {
  gateway.close();
  await new Promise<void>((resolve) => adapter.tryShutdown(() => resolve()));
  await pool.end();
});

describe("durable task lifecycle", () => {
  it("publishes before returning, maps working to completed, and survives engine restart", async () => {
    const operation = requiredOperation("durable_task");
    const created = await engine.callOperation(
      operation,
      { resourceId: "resource-1" },
      authorization,
    );
    expect(created.kind).toBe("task");
    if (created.kind !== "task") throw new Error("Expected task result");
    expect(created.task.status).toBe("working");
    const taskId = String(created.task.taskId);

    const visible = await pool.query<{ state: string }>(
      `SELECT admission_intent.state FROM provider_task
       JOIN admission_intent USING (task_id) WHERE provider_task.task_id=$1`,
      [taskId],
    );
    expect(visible.rows[0]?.state).toBe("PUBLISHED");

    const restarted = new TaskEngine(
      engine.manifest,
      engine.operationSnapshotIds,
      gateway,
      new TaskRepository(pool),
    );
    const completed = await restarted.getTask(taskId, authorization);
    expect(completed).toMatchObject({ taskId, status: "completed" });
    expect(completed.result).toMatchObject({
      isError: false,
      structuredContent: { outcome: "success", resourceId: "resource-1" },
    });

    const repository = new TaskRepository(pool);
    const unchanged = await repository.applySnapshot(taskId, 99, {
      internalState: "RUNNING",
      mcpStatus: "working",
      substate: "running",
      statusMessage: "late nonterminal snapshot",
      result: null,
      error: null,
      terminal: false,
      observationType: "task.progress",
    });
    expect(unchanged.mcpStatus).toBe("completed");
    await expect(
      restarted.getTask(taskId, { ...authorization, hash: "b".repeat(64) }),
    ).rejects.toThrow("TASK_NOT_FOUND");
  });

  it("returns an inline result for terminal task-capable admission", async () => {
    const before = await pool.query<{ count: string }>("SELECT count(*) FROM provider_task");
    const result = await engine.callOperation(
      requiredOperation("flex_task"),
      { resourceId: "resource-inline", scenario: "terminal" },
      authorization,
    );
    expect(result).toMatchObject({
      kind: "result",
      result: { structuredContent: { outcome: "success", resourceId: "resource-inline" } },
    });
    const after = await pool.query<{ count: string }>("SELECT count(*) FROM provider_task");
    expect(after.rows[0]?.count).toBe(before.rows[0]?.count);
  });

  it("uses official MCP task requests for immediate query and completion", async () => {
    const handler = new McpProtocolHandler(engine.manifest, gateway, engine);
    const app = Fastify();
    app.post("/mcp", async (request, reply) => {
      reply.hijack();
      await handler.handle(request.raw, reply.raw, request.body);
    });
    await app.listen({ host: "127.0.0.1", port: 0 });
    const address = app.server.address();
    if (address === null || typeof address === "string") throw new Error("MCP did not bind");
    const client = new Client({ name: "r3-integration", version: "1.0.0" });
    await client.connect(
      new StreamableHTTPClientTransport(
        new URL(`http://127.0.0.1:${String(address.port)}/mcp`),
      ) as unknown as Transport,
    );
    try {
      const created = await client.request(
        {
          method: "tools/call",
          params: { name: "durable_task", arguments: { resourceId: "resource-mcp" } },
        },
        CreateTaskResultSchema,
        { task: { ttl: 60_000 } },
      );
      expect(created.task.status).toBe("working");
      const completed = await client.experimental.tasks.getTask(created.task.taskId);
      expect(completed.status).toBe("completed");
    } finally {
      await client.close();
      await app.close();
    }
  });

  it("leaves an uncertain durable intent if publication fails after Adapter acceptance", async () => {
    await pool.query(`CREATE OR REPLACE FUNCTION fail_task_publish() RETURNS trigger LANGUAGE plpgsql AS $$
      BEGIN RAISE EXCEPTION 'injected task publish failure'; END $$`);
    await pool.query(`CREATE TRIGGER fail_task_publish BEFORE INSERT ON provider_task
      FOR EACH ROW EXECUTE FUNCTION fail_task_publish()`);
    try {
      await expect(
        engine.callOperation(
          requiredOperation("durable_task"),
          { resourceId: "resource-crash-window" },
          authorization,
        ),
      ).rejects.toThrow("injected task publish failure");
      const intent = await pool.query<{ state: string }>(
        `SELECT state FROM admission_intent
         WHERE arguments->>'resourceId'='resource-crash-window'`,
      );
      expect(intent.rows[0]?.state).toBe("UNCERTAIN");
      const leaked = await pool.query<{ count: string }>(
        `SELECT count(*) FROM provider_task
         WHERE arguments->>'resourceId'='resource-crash-window'`,
      );
      expect(leaked.rows[0]?.count).toBe("0");
    } finally {
      await pool.query("DROP TRIGGER IF EXISTS fail_task_publish ON provider_task");
      await pool.query("DROP FUNCTION IF EXISTS fail_task_publish()");
    }
  });

  it("leaves an uncertain durable intent when the StartOperation response is lost", async () => {
    const unavailableGateway = new GrpcAdapterGateway({
      endpoint: "127.0.0.1:1",
      providerId: "task-provider",
      timeoutMs: 250,
    });
    const uncertainEngine = new TaskEngine(
      engine.manifest,
      engine.operationSnapshotIds,
      unavailableGateway,
      new TaskRepository(pool),
    );
    try {
      await expect(
        uncertainEngine.callOperation(
          requiredOperation("durable_task"),
          { resourceId: "resource-response-loss" },
          authorization,
        ),
      ).rejects.toThrow();
      const intent = await pool.query<{ state: string }>(
        `SELECT state FROM admission_intent
         WHERE arguments->>'resourceId'='resource-response-loss'`,
      );
      expect(intent.rows[0]?.state).toBe("UNCERTAIN");
    } finally {
      unavailableGateway.close();
    }
  });
});

function requiredOperation(name: string) {
  const operation = engine.manifest.operations.find((candidate) => candidate.name === name);
  if (operation === undefined) throw new Error(`Operation ${name} is missing`);
  return operation;
}
