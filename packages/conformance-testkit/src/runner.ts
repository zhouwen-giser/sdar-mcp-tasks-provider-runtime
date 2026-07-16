import { randomUUID } from "node:crypto";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import type { Transport } from "@modelcontextprotocol/sdk/shared/transport.js";
import Fastify from "fastify";
import { Pool } from "pg";
import { GrpcAdapterGateway } from "../../adapter-protocol/src/index.js";
import type { AuthorizationContext, Clock } from "../../domain/src/index.js";
import { McpProtocolHandler } from "../../mcp-protocol/src/index.js";
import { OperationRegistry } from "../../operation-registry/src/index.js";
import {
  IdempotencyRepository,
  OperationSnapshotRepository,
  OutboxRepository,
  TaskRepository,
  runMigrations,
} from "../../persistence-postgres/src/index.js";
import { DurableScheduler, TaskEngine } from "../../task-engine/src/index.js";

export interface ConformanceOptions {
  language: "typescript" | "python";
  endpoint: string;
  providerId: string;
  databaseUrl: string;
}

export interface ConformanceReport {
  profileVersion: "1.0";
  adapterLanguage: string;
  providerId: string;
  generatedAt: string;
  status: "passed" | "failed";
  groups: GroupReport[];
}

interface GroupReport {
  id: "P0" | "P1" | "P2" | "P3" | "P4";
  status: "passed" | "failed";
  tests: CaseReport[];
}

interface CaseReport {
  name: string;
  status: "passed" | "failed";
  durationMs: number;
  error?: string;
}

const authorization: AuthorizationContext = {
  hash: "d".repeat(64),
  executionMode: "live",
  simulationId: null,
  correlationId: "conformance",
};

export async function runConformance(options: ConformanceOptions): Promise<ConformanceReport> {
  const pool = new Pool({ connectionString: options.databaseUrl, max: 8 });
  const gateway = new GrpcAdapterGateway({
    endpoint: options.endpoint,
    providerId: options.providerId,
    timeoutMs: 3_000,
  });
  const groups = new Map<GroupReport["id"], GroupReport>();
  for (const id of ["P0", "P1", "P2", "P3", "P4"] as const) {
    groups.set(id, { id, status: "passed", tests: [] });
  }
  try {
    await resetDatabase(pool);
    await runMigrations(pool);
    const manifest = new OperationRegistry().validate(await gateway.describeProvider());
    assert(manifest.providerId === options.providerId, "providerId mismatch");
    const snapshots = await new OperationSnapshotRepository(pool).saveManifest(manifest);
    const repository = new TaskRepository(pool);
    const engine = new TaskEngine(
      manifest,
      snapshots,
      gateway,
      repository,
      new IdempotencyRepository(pool),
    );

    await test(groups, "P0", "manifest and synchronous Tool", async () => {
      assert(manifest.operations.length === 3, "expected three operation definitions");
      const result = await engine.callOperation(
        operation(engine, "echo_sync"),
        { message: "cross-language" },
        authorization,
      );
      assert(result.kind === "result", "synchronous operation returned a Task");
      assert(result.result.isError === false, "synchronous result isError mismatch");
      await mcpRoundTrip(engine, gateway);
    });

    await test(groups, "P0", "task_required lifecycle", async () => {
      const created = await engine.callOperation(
        operation(engine, "durable_task"),
        { resourceId: `${options.language}-p0` },
        authorization,
      );
      assert(created.kind === "task", "task_required did not return a Task");
      const completed = await engine.getTask(String(created.task.taskId), authorization);
      assert(completed.status === "completed", "Task did not complete");
    });

    await test(groups, "P1", "availability states and windows", async () => {
      const availability = await engine.checkAvailability(
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
      assert(
        availability.checks.map((item) => item.availability).join(",") ===
          "available,restricted,disabled",
        "availability state mismatch",
      );
    });

    await test(groups, "P2", "durable scheduled start", async () => {
      const clock = new FakeClock(new Date("2031-01-01T00:00:00Z"));
      const timedEngine = new TaskEngine(
        manifest,
        snapshots,
        gateway,
        repository,
        new IdempotencyRepository(pool),
        clock,
      );
      const scheduler = new DurableScheduler(manifest, gateway, repository, clock, "conformance");
      const created = await timedEngine.callOperation(
        operation(engine, "durable_task"),
        { resourceId: `${options.language}-scheduled` },
        authorization,
        undefined,
        `scheduled-${options.language}`,
        {
          start: {
            mode: "scheduled",
            scheduledAt: "2031-01-01T00:00:01Z",
            startToleranceMs: 1_000,
          },
          maxElapsedMs: null,
        },
      );
      assert(created.kind === "task", "scheduled call did not publish a Task");
      assert((await scheduler.tick()).started === 0, "scheduled work started early");
      clock.advance(1_000);
      assert((await scheduler.tick()).started === 1, "scheduled work did not start once");
    });

    await test(groups, "P3", "multi-round input_required", async () => {
      const created = await engine.callOperation(
        operation(engine, "durable_task"),
        { resourceId: `${options.language}-input`, scenario: "multi_round_input" },
        authorization,
      );
      assert(created.kind === "task", "input operation did not return Task");
      const taskId = String(created.task.taskId);
      await engine.updateTask(taskId, { approval: true }, authorization);
      const second = await engine.getTask(taskId, authorization);
      assert(second.status === "input_required", "second input round missing");
      await engine.updateTask(taskId, { comment: "approved" }, authorization);
      assert(
        (await engine.getTask(taskId, authorization)).status === "completed",
        "input Task incomplete",
      );
    });

    await test(groups, "P3", "Ack-only cancel and command idempotency", async () => {
      const created = await engine.callOperation(
        operation(engine, "durable_task"),
        { resourceId: `${options.language}-cancel` },
        authorization,
      );
      assert(created.kind === "task", "cancel operation did not return Task");
      const taskId = String(created.task.taskId);
      assert(
        (await engine.cancelTask(taskId, authorization)).status === "working",
        "cancel was terminal early",
      );
      await engine.cancelTask(taskId, authorization);
      assert(
        (await engine.getTask(taskId, authorization)).status === "cancelled",
        "cancel proof missing",
      );
    });

    await test(groups, "P3", "idempotency duplicate and conflict", async () => {
      const key = `conformance-${options.language}`;
      const first = await engine.callOperation(
        operation(engine, "durable_task"),
        { resourceId: `${options.language}-idempotent` },
        authorization,
        undefined,
        key,
      );
      const second = await engine.callOperation(
        operation(engine, "durable_task"),
        { resourceId: `${options.language}-idempotent` },
        authorization,
        undefined,
        key,
      );
      assert(first.kind === "task" && second.kind === "task", "idempotent calls were not Tasks");
      assert(first.task.taskId === second.task.taskId, "duplicate taskId mismatch");
      await expectFailure(
        engine.callOperation(
          operation(engine, "durable_task"),
          { resourceId: "conflicting" },
          authorization,
          undefined,
          key,
        ),
        "IDEMPOTENCY_KEY_CONFLICT",
      );
    });

    await test(groups, "P4", "response-loss Reconcile", async () => {
      const key = `response-loss-${options.language}`;
      await expectFailure(
        engine.callOperation(
          operation(engine, "durable_task"),
          { resourceId: `${options.language}-response-loss`, scenario: "response_loss" },
          authorization,
          undefined,
          key,
        ),
        "response loss",
      );
      const recovered = await engine.callOperation(
        operation(engine, "durable_task"),
        { resourceId: `${options.language}-response-loss`, scenario: "response_loss" },
        authorization,
        undefined,
        key,
      );
      assert(recovered.kind === "task", "response loss did not reconcile to Task");
    });

    await test(groups, "P4", "Adapter identity conflict", async () => {
      const taskId = randomUUID();
      await gateway.startOperation(
        "durable_task",
        { resourceId: `${options.language}-binding` },
        { taskId, argumentHash: "1".repeat(64) },
      );
      await expectFailure(
        gateway.startOperation(
          "durable_task",
          { resourceId: `${options.language}-other-binding` },
          { taskId, argumentHash: "2".repeat(64) },
        ),
        "conflict",
      );
      const reconciled = await gateway.reconcileExecution(taskId, "durable_task", "2".repeat(64));
      assert(reconciled.status === "CONFLICT", "Reconcile did not report identity conflict");
    });

    await test(groups, "P4", "terminal irreversibility and outbox idempotency", async () => {
      const created = await engine.callOperation(
        operation(engine, "durable_task"),
        { resourceId: `${options.language}-terminal` },
        authorization,
      );
      assert(created.kind === "task", "terminal test Task missing");
      const taskId = String(created.task.taskId);
      await engine.getTask(taskId, authorization);
      const unchanged = await repository.applySnapshot(taskId, 999, {
        internalState: "RUNNING",
        mcpStatus: "working",
        substate: "running",
        statusMessage: "illegal regression",
        result: null,
        error: null,
        terminal: false,
        observationType: "task.progress",
      });
      assert(unchanged.mcpStatus === "completed", "terminal state regressed");
      const outbox = new OutboxRepository(pool);
      const event = (await outbox.pending(1))[0];
      assert(event !== undefined, "outbox event missing");
      assert((await outbox.markPublished([event.eventId])) === 1, "first delivery did not publish");
      assert(
        (await outbox.markPublished([event.eventId])) === 0,
        "duplicate delivery was not idempotent",
      );
    });
  } finally {
    gateway.close();
    await pool.end();
  }
  const groupReports = [...groups.values()];
  return {
    profileVersion: "1.0",
    adapterLanguage: options.language,
    providerId: options.providerId,
    generatedAt: new Date().toISOString(),
    status: groupReports.every((group) => group.status === "passed") ? "passed" : "failed",
    groups: groupReports,
  };
}

export async function seedAndVerifyAdapterBinding(
  endpoint: string,
  providerId: string,
  taskId: string = randomUUID(),
): Promise<{ taskId: string; argumentHash: string }> {
  const gateway = new GrpcAdapterGateway({ endpoint, providerId, timeoutMs: 3_000 });
  const argumentHash = "e".repeat(64);
  try {
    const response = await gateway.startOperation(
      "durable_task",
      { resourceId: "restart-binding" },
      { taskId, argumentHash },
    );
    assert(response.accepted !== undefined, "restart seed was not accepted");
    return { taskId, argumentHash };
  } finally {
    gateway.close();
  }
}

export async function verifyAdapterBinding(
  endpoint: string,
  providerId: string,
  binding: { taskId: string; argumentHash: string },
): Promise<void> {
  const gateway = new GrpcAdapterGateway({ endpoint, providerId, timeoutMs: 3_000 });
  try {
    const reconciled = await gateway.reconcileExecution(
      binding.taskId,
      "durable_task",
      binding.argumentHash,
    );
    assert(reconciled.status === "FOUND", "durable Adapter binding was lost across restart");
  } finally {
    gateway.close();
  }
}

async function resetDatabase(pool: Pool): Promise<void> {
  await pool.query(`DROP TABLE IF EXISTS
    runtime_lease, outbox_event, idempotency_record, task_command, task_input_request,
    task_observation, provider_task, admission_intent, operation_snapshot,
    runtime_schema_migration CASCADE`);
}

function operation(engine: TaskEngine, name: string) {
  const value = engine.manifest.operations.find((candidate) => candidate.name === name);
  if (value === undefined) throw new Error(`missing operation ${name}`);
  return value;
}

async function test(
  groups: Map<GroupReport["id"], GroupReport>,
  id: GroupReport["id"],
  name: string,
  run: () => Promise<void>,
): Promise<void> {
  const started = performance.now();
  const group = groups.get(id);
  if (group === undefined) throw new Error(`missing group ${id}`);
  try {
    await run();
    group.tests.push({ name, status: "passed", durationMs: performance.now() - started });
  } catch (error) {
    group.status = "failed";
    group.tests.push({
      name,
      status: "failed",
      durationMs: performance.now() - started,
      error: error instanceof Error ? error.message : String(error),
    });
  }
}

function assert(condition: boolean, message: string): asserts condition {
  if (!condition) throw new Error(message);
}

async function expectFailure(promise: Promise<unknown>, messageFragment: string): Promise<void> {
  try {
    await promise;
  } catch (error) {
    if (
      error instanceof Error &&
      error.message.toLowerCase().includes(messageFragment.toLowerCase())
    ) {
      return;
    }
    throw error;
  }
  throw new Error(`expected failure containing ${messageFragment}`);
}

class FakeClock implements Clock {
  constructor(private value: Date) {}
  now(): Date {
    return new Date(this.value);
  }
  advance(milliseconds: number): void {
    this.value = new Date(this.value.getTime() + milliseconds);
  }
}

async function mcpRoundTrip(engine: TaskEngine, gateway: GrpcAdapterGateway): Promise<void> {
  const app = Fastify();
  const handler = new McpProtocolHandler(engine.manifest, gateway, engine);
  app.post("/mcp", async (request, reply) => {
    reply.hijack();
    await handler.handle(request.raw, reply.raw, request.body);
  });
  await app.listen({ host: "127.0.0.1", port: 0 });
  const address = app.server.address();
  if (address === null || typeof address === "string") throw new Error("MCP server did not bind");
  const client = new Client({ name: "conformance", version: "1.0.0" });
  try {
    await client.connect(
      new StreamableHTTPClientTransport(
        new URL(`http://127.0.0.1:${String(address.port)}/mcp`),
      ) as unknown as Transport,
    );
    const tools = await client.listTools();
    assert(tools.tools.length === 3, "MCP Tool catalog mismatch");
    const result = await client.callTool({ name: "echo_sync", arguments: { message: "mcp" } });
    assert(result.isError !== true, "MCP synchronous call failed");
  } finally {
    await client.close();
    await app.close();
  }
}
