import Fastify from "fastify";
import { Pool } from "pg";
import { GrpcAdapterGateway } from "../../../packages/adapter-protocol/src/index.js";
import type { ProviderManifest } from "../../../packages/adapter-protocol/src/index.js";
import { McpProtocolHandler } from "../../../packages/mcp-protocol/src/index.js";
import { createLogger } from "../../../packages/observability/src/index.js";
import type { RuntimeLogger } from "../../../packages/observability/src/index.js";
import { OperationRegistry } from "../../../packages/operation-registry/src/index.js";
import {
  OperationSnapshotRepository,
  IdempotencyRepository,
  TaskRepository,
  runMigrations,
} from "../../../packages/persistence-postgres/src/index.js";
import { DurableScheduler, TaskEngine } from "../../../packages/task-engine/src/index.js";
import type { RuntimeConfig } from "./config.js";

function createHttpServer(logger: RuntimeLogger) {
  return Fastify({ loggerInstance: logger });
}

type RuntimeHttpServer = ReturnType<typeof createHttpServer>;

export interface RuntimeDependencies {
  database: "starting" | "ready" | "failed";
  adapter: "starting" | "ready" | "failed";
  recovery: "starting" | "ready" | "failed";
}

export interface RuntimeApplication {
  app: RuntimeHttpServer;
  gateway: GrpcAdapterGateway;
  pool: Pool;
  dependencies: RuntimeDependencies;
  initialize(): Promise<ProviderManifest>;
}

export function createRuntime(config: RuntimeConfig): RuntimeApplication {
  const logger = createLogger(config.LOG_LEVEL);
  const app = createHttpServer(logger);
  const pool = new Pool({ connectionString: config.DATABASE_URL, max: 10 });
  const gateway = new GrpcAdapterGateway({
    endpoint: config.ADAPTER_ENDPOINT,
    providerId: config.PROVIDER_ID,
    timeoutMs: config.ADAPTER_RPC_TIMEOUT_MS,
  });
  const dependencies: RuntimeDependencies = {
    database: "starting",
    adapter: "starting",
    recovery: "starting",
  };
  let manifest: ProviderManifest | undefined;
  let mcpHandler: McpProtocolHandler | undefined;
  let schedulerTimer: NodeJS.Timeout | undefined;
  let schedulerTicking = false;

  app.get("/health/live", () => ({ status: "live" }));
  app.get("/health/ready", async (_request, reply) => {
    const ready = Object.values(dependencies).every((status) => status === "ready");
    return reply
      .code(ready ? 200 : 503)
      .send({ status: ready ? "ready" : "not_ready", dependencies });
  });
  app.get("/internal/provider", async (_request, reply) => {
    if (manifest === undefined) return reply.code(503).send({ error: "manifest_not_loaded" });
    return manifest;
  });
  app.all("/mcp", async (request, reply) => {
    if (request.method !== "POST") {
      return reply.code(405).send({
        jsonrpc: "2.0",
        error: { code: -32_000, message: "Method not allowed." },
        id: null,
      });
    }
    if (mcpHandler === undefined) {
      return reply.code(503).send({
        jsonrpc: "2.0",
        error: { code: -32_003, message: "Provider not ready." },
        id: null,
      });
    }
    reply.hijack();
    await mcpHandler.handle(request.raw, reply.raw, request.body);
  });

  app.addHook("onClose", async () => {
    if (schedulerTimer !== undefined) clearInterval(schedulerTimer);
    gateway.close();
    await pool.end();
  });

  async function initialize(): Promise<ProviderManifest> {
    try {
      await runMigrations(pool);
      await pool.query("SELECT 1 AS runtime_database_ready");
      dependencies.database = "ready";
    } catch (error) {
      dependencies.database = "failed";
      throw error;
    }

    try {
      manifest = await gateway.describeProvider();
      if (manifest.providerId !== config.PROVIDER_ID) {
        throw new Error(
          `Adapter provider id ${manifest.providerId} does not match configured ${config.PROVIDER_ID}`,
        );
      }
      const validated = new OperationRegistry().validate(manifest);
      const snapshotIds = await new OperationSnapshotRepository(pool).saveManifest(validated);
      const taskEngine = new TaskEngine(
        validated,
        snapshotIds,
        gateway,
        new TaskRepository(pool),
        new IdempotencyRepository(pool),
      );
      mcpHandler = new McpProtocolHandler(validated, gateway, taskEngine);
      const scheduler = new DurableScheduler(validated, gateway, new TaskRepository(pool));
      await scheduler.tick();
      schedulerTimer = setInterval(() => {
        if (schedulerTicking) return;
        schedulerTicking = true;
        void scheduler
          .tick()
          .catch((error: unknown) => logger.error({ err: error }, "scheduler tick failed"))
          .finally(() => {
            schedulerTicking = false;
          });
      }, config.SCHEDULER_POLL_MS);
      schedulerTimer.unref();
      dependencies.adapter = "ready";
    } catch (error) {
      dependencies.adapter = "failed";
      throw error;
    }

    // R1 has no provider tasks to recover. The dependency remains explicit so
    // R3-R7 can make readiness wait for migrations and the recovery scan.
    dependencies.recovery = "ready";
    logger.info(
      { providerId: manifest.providerId, providerVersion: manifest.providerVersion },
      "runtime dependencies initialized",
    );
    return manifest;
  }

  return { app, gateway, pool, dependencies, initialize };
}
