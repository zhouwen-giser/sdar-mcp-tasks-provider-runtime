import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import type { Transport } from "@modelcontextprotocol/sdk/shared/transport.js";
import { CallToolResultSchema, CreateTaskResultSchema } from "@modelcontextprotocol/sdk/types.js";
import Fastify from "fastify";
import type * as grpc from "@grpc/grpc-js";
import { Pool } from "pg";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { z } from "zod";
import {
  bindMockAdapter,
  createMockAdapterServer,
} from "../../examples/mock-adapter-typescript/src/server.js";
import { GrpcAdapterGateway } from "../../packages/adapter-protocol/src/index.js";
import type { AuthorizationContext, Clock } from "../../packages/domain/src/index.js";
import { McpProtocolHandler } from "../../packages/mcp-protocol/src/index.js";
import { OperationRegistry } from "../../packages/operation-registry/src/index.js";
import {
  OperationSnapshotRepository,
  IdempotencyRepository,
  OutboxRepository,
  TaskRepository,
  runMigrations,
} from "../../packages/persistence-postgres/src/index.js";
import { DurableScheduler, TaskEngine } from "../../packages/task-engine/src/index.js";

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
let sideEffectCount = 0;
let controlSideEffectCount = 0;

class FakeClock implements Clock {
  constructor(private value: Date) {}
  now(): Date {
    return new Date(this.value);
  }
  advance(milliseconds: number): void {
    this.value = new Date(this.value.getTime() + milliseconds);
  }
}

beforeAll(async () => {
  await pool.query(`DROP TABLE IF EXISTS
    runtime_lease, outbox_event, idempotency_record, task_input_request,
    task_observation, provider_task, admission_intent, operation_snapshot,
    runtime_schema_migration CASCADE`);
  await runMigrations(pool);
  adapter = createMockAdapterServer({
    providerId: "task-provider",
    onStartSideEffect: () => {
      sideEffectCount += 1;
    },
    onControlSideEffect: () => {
      controlSideEffectCount += 1;
    },
  });
  const port = await bindMockAdapter(adapter, "127.0.0.1:0");
  gateway = new GrpcAdapterGateway({
    endpoint: `127.0.0.1:${String(port)}`,
    providerId: "task-provider",
  });
  const manifest = new OperationRegistry().validate(await gateway.describeProvider());
  const snapshots = await new OperationSnapshotRepository(pool).saveManifest(manifest);
  engine = new TaskEngine(
    manifest,
    snapshots,
    gateway,
    new TaskRepository(pool),
    new IdempotencyRepository(pool),
  );
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
      const availability = await client.request(
        {
          method: "io.sdar/taskExecution/checkAvailability",
          params: {
            checks: [
              {
                requestId: "mcp-availability",
                operationName: "durable_task",
                arguments: { resourceId: "resource-mcp" },
              },
            ],
          },
        },
        z.object({
          profileVersion: z.literal("1.0"),
          checkedAt: z.string(),
          checks: z.array(z.object({ availability: z.string() }).loose()),
        }),
      );
      expect(availability.checks[0]?.availability).toBe("available");

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
      expect(
        await client.experimental.tasks.getTaskResult(created.task.taskId, CallToolResultSchema),
      ).toMatchObject({ isError: false });

      const beforeIdempotentMcp = sideEffectCount;
      const idempotentParams = {
        name: "durable_task",
        arguments: { resourceId: "resource-mcp-idempotent" },
        _meta: {
          "io.sdar/taskExecution": { idempotencyKey: "mcp-idempotency-key" },
        },
      };
      const idempotentFirst = await client.request(
        { method: "tools/call", params: idempotentParams },
        CreateTaskResultSchema,
        { task: { ttl: 60_000 } },
      );
      const idempotentDuplicate = await client.request(
        { method: "tools/call", params: idempotentParams },
        CreateTaskResultSchema,
        { task: { ttl: 60_000 } },
      );
      expect(idempotentDuplicate.task.taskId).toBe(idempotentFirst.task.taskId);
      expect(sideEffectCount - beforeIdempotentMcp).toBe(1);

      const beforeScheduledMcp = sideEffectCount;
      const scheduled = await client.request(
        {
          method: "tools/call",
          params: {
            name: "durable_task",
            arguments: { resourceId: "resource-mcp-scheduled" },
            _meta: {
              "io.sdar/taskExecution": {
                idempotencyKey: "mcp-scheduled-key",
                timing: {
                  start: {
                    mode: "scheduled",
                    scheduledAt: "2030-01-01T00:00:00Z",
                    startToleranceMs: 30_000,
                  },
                  maxElapsedMs: null,
                },
              },
            },
          },
        },
        CreateTaskResultSchema,
        { task: { ttl: 60_000 } },
      );
      expect(scheduled.task.status).toBe("working");
      expect(sideEffectCount).toBe(beforeScheduledMcp);

      const inputTask = await client.request(
        {
          method: "tools/call",
          params: {
            name: "durable_task",
            arguments: { resourceId: "resource-mcp-input", scenario: "input_required" },
          },
        },
        CreateTaskResultSchema,
        { task: { ttl: 60_000 } },
      );
      expect(inputTask.task.status).toBe("input_required");
      await client.request(
        {
          method: "tasks/update",
          params: { taskId: inputTask.task.taskId, inputs: { approval: true } },
        },
        z.object({}).loose(),
      );
      expect((await client.experimental.tasks.getTask(inputTask.task.taskId)).status).toBe(
        "completed",
      );

      const cancelTask = await client.request(
        {
          method: "tools/call",
          params: { name: "durable_task", arguments: { resourceId: "resource-mcp-cancel" } },
        },
        CreateTaskResultSchema,
        { task: { ttl: 60_000 } },
      );
      expect((await client.experimental.tasks.cancelTask(cancelTask.task.taskId)).status).toBe(
        "working",
      );
      expect((await client.experimental.tasks.getTask(cancelTask.task.taskId)).status).toBe(
        "cancelled",
      );
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

  it("serializes concurrent idempotent calls and restores task/result across restart", async () => {
    const before = sideEffectCount;
    const operation = requiredOperation("durable_task");
    const secondRuntime = new TaskEngine(
      engine.manifest,
      engine.operationSnapshotIds,
      gateway,
      new TaskRepository(pool),
      new IdempotencyRepository(pool),
    );
    const [first, duplicate] = await Promise.all([
      engine.callOperation(
        operation,
        { resourceId: "resource-idempotent" },
        authorization,
        undefined,
        "same-task-key",
      ),
      secondRuntime.callOperation(
        operation,
        { resourceId: "resource-idempotent" },
        authorization,
        undefined,
        "same-task-key",
      ),
    ]);
    expect(first.kind).toBe("task");
    expect(duplicate.kind).toBe("task");
    if (first.kind !== "task" || duplicate.kind !== "task") throw new Error("Expected tasks");
    expect(duplicate.task.taskId).toBe(first.task.taskId);
    expect(sideEffectCount - before).toBe(1);

    await expect(
      engine.callOperation(
        operation,
        { resourceId: "different-arguments" },
        authorization,
        undefined,
        "same-task-key",
      ),
    ).rejects.toThrow("IDEMPOTENCY_KEY_CONFLICT");

    const syncBefore = sideEffectCount;
    const sync = requiredOperation("echo_sync");
    const syncFirst = await engine.callOperation(
      sync,
      { message: "deduplicated" },
      authorization,
      undefined,
      "same-sync-key",
    );
    const syncAgain = await secondRuntime.callOperation(
      sync,
      { message: "deduplicated" },
      authorization,
      undefined,
      "same-sync-key",
    );
    expect(syncAgain).toEqual(syncFirst);
    expect(sideEffectCount - syncBefore).toBe(1);
  });

  it("recovers a pending idempotent admission through Reconcile", async () => {
    const before = sideEffectCount;
    const operation = requiredOperation("durable_task");
    await expect(
      engine.callOperation(
        operation,
        { resourceId: "resource-reconcile", scenario: "response_loss" },
        authorization,
        undefined,
        "response-loss-key",
      ),
    ).rejects.toThrow("injected StartOperation response loss");

    const recovered = await engine.callOperation(
      operation,
      { resourceId: "resource-reconcile", scenario: "response_loss" },
      authorization,
      undefined,
      "response-loss-key",
    );
    expect(recovered.kind).toBe("task");
    expect(sideEffectCount - before).toBe(1);
    const rows = await pool.query<{ state: string }>(
      `SELECT state FROM idempotency_record WHERE idempotency_key='response-loss-key'`,
    );
    expect(rows.rows[0]?.state).toBe("COMPLETE");
  });

  it("maps batched Availability and returns unknown on Adapter transport failure", async () => {
    const response = await engine.checkAvailability(
      [
        { requestId: "available", operationName: "durable_task", arguments: { resourceId: "a" } },
        {
          requestId: "restricted",
          operationName: "durable_task",
          arguments: { resourceId: "b", scenario: "restricted" },
        },
        {
          requestId: "disabled",
          operationName: "durable_task",
          arguments: { resourceId: "c", scenario: "disabled" },
        },
      ],
      authorization,
    );
    expect(response.checks.map((check) => check.availability)).toEqual([
      "available",
      "restricted",
      "disabled",
    ]);

    const unavailable = new GrpcAdapterGateway({
      endpoint: "127.0.0.1:1",
      providerId: "task-provider",
      timeoutMs: 250,
    });
    try {
      const fallbackEngine = new TaskEngine(
        engine.manifest,
        engine.operationSnapshotIds,
        unavailable,
        new TaskRepository(pool),
      );
      const fallback = await fallbackEngine.checkAvailability(
        [{ requestId: "unknown", operationName: "durable_task", arguments: { resourceId: "u" } }],
        authorization,
      );
      expect(fallback.checks[0]).toMatchObject({
        availability: "unknown",
        reasonCode: "ADAPTER_TRANSIENT_UNAVAILABLE",
      });
    } finally {
      unavailable.close();
    }
  });

  it("starts scheduled work no earlier than notBefore and only once across workers", async () => {
    const clock = new FakeClock(new Date("2026-07-16T12:00:00Z"));
    const scheduledEngine = new TaskEngine(
      engine.manifest,
      engine.operationSnapshotIds,
      gateway,
      new TaskRepository(pool),
      new IdempotencyRepository(pool),
      clock,
    );
    const repository = new TaskRepository(pool);
    const firstWorker = new DurableScheduler(
      engine.manifest,
      gateway,
      repository,
      clock,
      "worker-1",
    );
    const secondWorker = new DurableScheduler(
      engine.manifest,
      gateway,
      new TaskRepository(pool),
      clock,
      "worker-2",
    );
    const before = sideEffectCount;
    const created = await scheduledEngine.callOperation(
      requiredOperation("durable_task"),
      { resourceId: "resource-scheduled" },
      authorization,
      undefined,
      "scheduled-idempotency",
      {
        start: {
          mode: "scheduled",
          scheduledAt: "2026-07-16T12:00:01Z",
          startToleranceMs: 1_000,
        },
        maxElapsedMs: 5_000,
      },
    );
    expect(created.kind).toBe("task");
    if (created.kind !== "task") throw new Error("Expected scheduled task");
    expect(created.task).toMatchObject({ status: "working" });
    expect(sideEffectCount).toBe(before);
    expect(await firstWorker.tick()).toMatchObject({ started: 0 });
    expect(sideEffectCount).toBe(before);

    clock.advance(1_000);
    const claims = await Promise.all([firstWorker.tick(), secondWorker.tick()]);
    expect(claims.reduce((sum, tick) => sum + tick.started, 0)).toBe(1);
    expect(sideEffectCount - before).toBe(1);
    const task = await scheduledEngine.getTask(String(created.task.taskId), authorization);
    expect(task.status).toBe("completed");
  });

  it("completes a missed start window without invoking the Adapter", async () => {
    const clock = new FakeClock(new Date("2026-07-16T13:00:00Z"));
    const scheduledEngine = new TaskEngine(
      engine.manifest,
      engine.operationSnapshotIds,
      gateway,
      new TaskRepository(pool),
      undefined,
      clock,
    );
    const scheduler = new DurableScheduler(
      engine.manifest,
      gateway,
      new TaskRepository(pool),
      clock,
      "miss-worker",
    );
    const before = sideEffectCount;
    const created = await scheduledEngine.callOperation(
      requiredOperation("durable_task"),
      { resourceId: "resource-window-missed" },
      authorization,
      undefined,
      undefined,
      {
        start: {
          mode: "scheduled",
          scheduledAt: "2026-07-16T13:00:01Z",
          startToleranceMs: 500,
        },
        maxElapsedMs: null,
      },
    );
    if (created.kind !== "task") throw new Error("Expected scheduled task");
    clock.advance(2_000);
    expect(await scheduler.tick()).toMatchObject({ missed: 1, started: 0 });
    expect(sideEffectCount).toBe(before);
    const completed = await scheduledEngine.getTask(String(created.task.taskId), authorization);
    expect(completed).toMatchObject({
      status: "completed",
      result: { isError: true, structuredContent: { outcome: "start_window_missed" } },
    });
  });

  it("requests safe stop at maxElapsed and publishes deadline only after Adapter proof", async () => {
    const clock = new FakeClock(new Date("2026-07-16T14:00:00Z"));
    const timedEngine = new TaskEngine(
      engine.manifest,
      engine.operationSnapshotIds,
      gateway,
      new TaskRepository(pool),
      undefined,
      clock,
    );
    const scheduler = new DurableScheduler(
      engine.manifest,
      gateway,
      new TaskRepository(pool),
      clock,
      "deadline-worker",
    );
    const created = await timedEngine.callOperation(
      requiredOperation("durable_task"),
      { resourceId: "resource-deadline" },
      authorization,
      undefined,
      undefined,
      {
        start: { mode: "immediate", startToleranceMs: 1_000 },
        maxElapsedMs: 2_000,
      },
    );
    if (created.kind !== "task") throw new Error("Expected timed task");
    clock.advance(2_001);
    expect(await scheduler.tick()).toMatchObject({ deadlineStops: 1 });
    const stopping = await new TaskRepository(pool).getById(String(created.task.taskId));
    expect(stopping).toMatchObject({ mcpStatus: "working", internalState: "STOPPING" });
    const completed = await timedEngine.getTask(String(created.task.taskId), authorization);
    expect(completed).toMatchObject({
      status: "completed",
      result: { structuredContent: { outcome: "deadline_reached" } },
    });
  });

  it("persists stable input requests and applies idempotent validated updates", async () => {
    const created = await engine.callOperation(
      requiredOperation("durable_task"),
      { resourceId: "resource-input", scenario: "input_required" },
      authorization,
    );
    if (created.kind !== "task") throw new Error("Expected input task");
    expect(created.task).toMatchObject({
      status: "input_required",
      inputRequests: [{ key: "approval", required: true }],
    });
    const taskId = String(created.task.taskId);
    const repeated = await engine.getTask(taskId, authorization);
    expect(repeated).toMatchObject({
      status: "input_required",
      inputRequests: [{ key: "approval" }],
    });

    const before = controlSideEffectCount;
    await expect(engine.updateTask(taskId, { unknown: true }, authorization)).rejects.toThrow(
      "UNKNOWN_INPUT_REQUEST_KEY",
    );
    expect(controlSideEffectCount).toBe(before);
    await engine.updateTask(taskId, { approval: true }, authorization);
    await engine.updateTask(taskId, { approval: true }, authorization);
    expect(controlSideEffectCount - before).toBe(1);
    const completed = await engine.getTask(taskId, authorization);
    expect(completed.status).toBe("completed");
    await expect(engine.updateTask(taskId, { approval: false }, authorization)).rejects.toThrow(
      "INPUT_ANSWER_CONFLICT",
    );
  });

  it("supports multiple durable input_required rounds with stable unique keys", async () => {
    const created = await engine.callOperation(
      requiredOperation("durable_task"),
      { resourceId: "resource-multi-input", scenario: "multi_round_input" },
      authorization,
    );
    if (created.kind !== "task") throw new Error("Expected multi-round input task");
    const taskId = String(created.task.taskId);
    expect(created.task).toMatchObject({
      status: "input_required",
      inputRequests: [{ key: "approval" }],
    });

    await engine.updateTask(taskId, { approval: true }, authorization);
    const secondRound = await engine.getTask(taskId, authorization);
    expect(secondRound).toMatchObject({
      status: "input_required",
      inputRequests: [{ key: "comment" }],
    });
    await engine.updateTask(taskId, { comment: "approved after review" }, authorization);
    expect(await engine.getTask(taskId, authorization)).toMatchObject({ status: "completed" });

    const requests = await new TaskRepository(pool).listInputRequests(taskId);
    expect(requests.map(({ key, status }) => ({ key, status }))).toEqual([
      { key: "approval", status: "ANSWERED" },
      { key: "comment", status: "ANSWERED" },
    ]);
  });

  it("keeps cancellation Ack-only, idempotent, and preserves natural completion races", async () => {
    const created = await engine.callOperation(
      requiredOperation("durable_task"),
      { resourceId: "resource-cancel" },
      authorization,
    );
    if (created.kind !== "task") throw new Error("Expected cancellable task");
    const taskId = String(created.task.taskId);
    const before = controlSideEffectCount;
    const acknowledged = await engine.cancelTask(taskId, authorization);
    expect(acknowledged).toMatchObject({ status: "working" });
    expect(
      (acknowledged._meta as Record<string, Record<string, unknown>>)["io.sdar/taskExecution"],
    ).toMatchObject({ substate: "stopping" });
    await engine.cancelTask(taskId, authorization);
    expect(controlSideEffectCount - before).toBe(1);
    expect(await engine.getTask(taskId, authorization)).toMatchObject({ status: "cancelled" });

    const race = await engine.callOperation(
      requiredOperation("durable_task"),
      { resourceId: "resource-natural-race", scenario: "natural_completion" },
      authorization,
    );
    if (race.kind !== "task") throw new Error("Expected race task");
    const raceId = String(race.task.taskId);
    expect(await engine.cancelTask(raceId, authorization)).toMatchObject({ status: "working" });
    expect(await engine.getTask(raceId, authorization)).toMatchObject({
      status: "completed",
      result: { structuredContent: { outcome: "success" } },
    });

    const deadlineClock = new FakeClock(new Date("2026-07-16T15:00:00Z"));
    const deadlineEngine = new TaskEngine(
      engine.manifest,
      engine.operationSnapshotIds,
      gateway,
      new TaskRepository(pool),
      undefined,
      deadlineClock,
    );
    const deadlineTask = await deadlineEngine.callOperation(
      requiredOperation("durable_task"),
      { resourceId: "resource-deadline-cancel-race" },
      authorization,
      undefined,
      undefined,
      {
        start: { mode: "immediate", startToleranceMs: 0 },
        maxElapsedMs: 1_000,
      },
    );
    if (deadlineTask.kind !== "task") throw new Error("Expected deadline race task");
    deadlineClock.advance(1_001);
    const deadlineScheduler = new DurableScheduler(
      engine.manifest,
      gateway,
      new TaskRepository(pool),
      deadlineClock,
      "deadline-race-worker",
    );
    await deadlineScheduler.tick();
    const controlsBeforeDuplicate = controlSideEffectCount;
    await deadlineEngine.cancelTask(String(deadlineTask.task.taskId), authorization);
    expect(controlSideEffectCount).toBe(controlsBeforeDuplicate);
    expect(
      await deadlineEngine.getTask(String(deadlineTask.task.taskId), authorization),
    ).toMatchObject({
      status: "completed",
      result: { structuredContent: { outcome: "deadline_reached" } },
    });
  });

  it("records pause/resume observations without changing Workflow status", async () => {
    const created = await engine.callOperation(
      requiredOperation("durable_task"),
      { resourceId: "resource-pause" },
      authorization,
    );
    if (created.kind !== "task") throw new Error("Expected pausable task");
    const taskId = String(created.task.taskId);
    const paused = await engine.controlTask(taskId, "PAUSE", authorization);
    expect(paused).toMatchObject({ status: "working" });
    expect(
      (paused._meta as Record<string, Record<string, unknown>>)["io.sdar/taskExecution"],
    ).toMatchObject({ substate: "paused" });
    const resumed = await engine.controlTask(taskId, "RESUME", authorization);
    expect(resumed.status).toBe("working");
    expect(
      (resumed._meta as Record<string, Record<string, unknown>>)["io.sdar/taskExecution"],
    ).toMatchObject({ substate: "resuming" });
    const completed = await engine.getTask(taskId, authorization);
    expect(completed.status).toBe("completed");
    const observations = ((completed._meta as Record<string, Record<string, unknown>>)[
      "io.sdar/taskExecution"
    ]?.observations ?? []) as { revision: number; type: string }[];
    expect(observations.map((observation) => observation.revision)).toEqual(
      [...new Set(observations.map((observation) => observation.revision))].sort((a, b) => a - b),
    );
    expect(observations.some((observation) => observation.type === "task.paused")).toBe(true);

    const outbox = new OutboxRepository(pool);
    const pending = await outbox.pending(1);
    const event = pending[0];
    if (event === undefined) throw new Error("Expected a pending outbox event");
    expect(await outbox.markPublished([event.eventId])).toBe(1);
    expect((await outbox.pending()).some((candidate) => candidate.eventId === event.eventId)).toBe(
      false,
    );
  });
});

function requiredOperation(name: string) {
  const operation = engine.manifest.operations.find((candidate) => candidate.name === name);
  if (operation === undefined) throw new Error(`Operation ${name} is missing`);
  return operation;
}
