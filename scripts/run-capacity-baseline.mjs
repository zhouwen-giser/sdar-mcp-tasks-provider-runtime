import { performance } from "node:perf_hooks";
import { cpus, totalmem } from "node:os";
import { mkdirSync, writeFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import process from "node:process";
import { URL } from "node:url";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import { CreateTaskResultSchema } from "@modelcontextprotocol/sdk/types.js";
import {
  bindMockAdapter,
  createMockAdapterServer,
} from "../dist/examples/mock-adapter-typescript/src/server.js";
import { loadRuntimeConfig } from "../dist/apps/runtime/src/config.js";
import { createRuntime } from "../dist/apps/runtime/src/runtime.js";

const databaseUrl = process.env.TEST_DATABASE_URL;
if (databaseUrl === undefined) throw new Error("TEST_DATABASE_URL is required");

const adapter = createMockAdapterServer({ providerId: "capacity-provider" });
const adapterPort = await bindMockAdapter(adapter, "127.0.0.1:0");
const runtime = createRuntime(
  loadRuntimeConfig({
    DATABASE_URL: databaseUrl,
    PROVIDER_ID: "capacity-provider",
    ADAPTER_ENDPOINT: `127.0.0.1:${String(adapterPort)}`,
    AUTH_MODE: "development",
    LOG_LEVEL: "warn",
    SCHEDULER_POLL_MS: "1000",
    RECOVERY_POLL_MS: "5000",
  }),
);
let client;

try {
  await runtime.initialize();
  await runtime.app.listen({ host: "127.0.0.1", port: 0 });
  const address = runtime.app.server.address();
  if (address === null || typeof address === "string") throw new Error("Runtime did not bind");
  client = new Client({ name: "runtime-capacity-baseline", version: "1.0.0" });
  await client.connect(
    new StreamableHTTPClientTransport(new URL(`http://127.0.0.1:${String(address.port)}/mcp`)),
  );

  const synchronous = await measure(100, async (index) => {
    const result = await client.callTool({
      name: "echo_sync",
      arguments: { message: `capacity-${index}` },
    });
    if (result.isError === true) throw new Error("Synchronous baseline call failed");
  });
  const tasks = await measure(25, async (index) => {
    const created = await client.request(
      {
        method: "tools/call",
        params: {
          name: "durable_task",
          arguments: { resourceId: `capacity-task-${index}` },
        },
      },
      CreateTaskResultSchema,
      { task: { ttl: 60_000 } },
    );
    const completed = await client.experimental.tasks.getTask(created.task.taskId);
    if (completed.status !== "completed") throw new Error("Task baseline did not complete");
  });

  const report = {
    version: "1.0.0-rc.1",
    generatedAt: new Date().toISOString(),
    environment: {
      node: process.version,
      platform: `${process.platform}/${process.arch}`,
      cpuLogicalCount: cpus().length,
      memoryBytes: totalmem(),
      database:
        process.env.GITHUB_ACTIONS === "true"
          ? "PostgreSQL 17 GitHub Actions service"
          : "TEST_DATABASE_URL target (credentials redacted)",
      topology: "single Runtime, single TypeScript Adapter, sequential MCP HTTP client",
    },
    workloads: { synchronousTool: synchronous, durableTaskCreateAndGet: tasks },
  };
  const outputPath = resolve(
    process.env.CAPACITY_REPORT_PATH ?? "reports/capacity/runtime-v1.json",
  );
  mkdirSync(dirname(outputPath), { recursive: true });
  writeFileSync(outputPath, `${JSON.stringify(report, null, 2)}\n`, { mode: 0o644 });
  process.stdout.write(`${JSON.stringify(report)}\n`);
} finally {
  await client?.close();
  await runtime.app.close();
  await new Promise((resolveShutdown) => adapter.tryShutdown(resolveShutdown));
}

async function measure(iterations, operation) {
  const latencies = [];
  const started = performance.now();
  for (let index = 0; index < iterations; index += 1) {
    const requestStarted = performance.now();
    await operation(index);
    latencies.push(performance.now() - requestStarted);
  }
  const durationMs = performance.now() - started;
  latencies.sort((left, right) => left - right);
  return {
    iterations,
    durationMs,
    throughputPerSecond: (iterations * 1000) / durationMs,
    latencyMs: {
      p50: percentile(latencies, 0.5),
      p95: percentile(latencies, 0.95),
      p99: percentile(latencies, 0.99),
      max: latencies.at(-1),
    },
  };
}

function percentile(values, fraction) {
  return values[Math.min(values.length - 1, Math.ceil(values.length * fraction) - 1)];
}
