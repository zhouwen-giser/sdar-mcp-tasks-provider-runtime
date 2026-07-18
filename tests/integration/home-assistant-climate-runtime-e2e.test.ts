import { createServer } from "node:net";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import type { Transport } from "@modelcontextprotocol/sdk/shared/transport.js";
import { CreateTaskResultSchema } from "@modelcontextprotocol/sdk/types.js";
import { Pool } from "pg";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { loadRuntimeConfig } from "../../apps/runtime/src/config.js";
import { createRuntime, type RuntimeApplication } from "../../apps/runtime/src/runtime.js";
import { ClimateExecutionEngine } from "../../apps/home-assistant-climate-provider/src/execution.js";
import {
  HomeAssistantClimateClient,
  HomeAssistantClimateWebSocket,
  normalizeClimateState,
} from "../../apps/home-assistant-climate-provider/src/home-assistant.js";
import { ClimateResourceRegistry } from "../../apps/home-assistant-climate-provider/src/resources.js";
import { ClimateProviderServer } from "../../apps/home-assistant-climate-provider/src/server.js";
import { MemoryClimateStore } from "../../apps/home-assistant-climate-provider/src/store.js";
import { ProviderClimateTelemetry } from "../../apps/home-assistant-climate-provider/src/telemetry.js";
import { FakeHomeAssistantClimate } from "../fixtures/fake-home-assistant-climate.js";
const databaseUrl = process.env.TEST_DATABASE_URL;
if (databaseUrl === undefined) throw new Error("TEST_DATABASE_URL is required for climate E2E");
let fake: FakeHomeAssistantClimate;
let provider: ClimateProviderServer;
let ws: HomeAssistantClimateWebSocket;
let telemetry: ProviderClimateTelemetry;
let runtime: RuntimeApplication;
let client: Client;
let pool: Pool;
beforeAll(async () => {
  pool = new Pool({ connectionString: databaseUrl, max: 1 });
  await pool.query(
    `DROP TABLE IF EXISTS provider_ops_delivery,runtime_lease,outbox_event,idempotency_record,task_command,task_input_request,task_observation,provider_task,admission_intent,operation_snapshot,runtime_schema_migration CASCADE`,
  );
  fake = new FakeHomeAssistantClimate();
  fake.setState("climate.e2e", "off", {
    current_temperature: 28,
    temperature: 24,
    min_temp: 16,
    max_temp: 30,
    hvac_modes: ["cool", "heat"],
    temperature_unit: "°C",
  });
  await fake.start();
  const telemetryPort = await freePort();
  const registry = new ClimateResourceRegistry([
    {
      resourceId: "e2e-climate",
      entityId: "climate.e2e",
      displayName: "E2E AC",
      enabled: true,
      temperatureRange: { minimum: 16, maximum: 30 },
      allowedHvacModes: ["cool", "heat"],
    },
  ]);
  const rest = new HomeAssistantClimateClient({
    baseUrl: fake.url,
    token: fake.token,
    timeoutMs: 1000,
  });
  const store = new MemoryClimateStore();
  telemetry = new ProviderClimateTelemetry(
    {
      providerId: "home-assistant-climate",
      endpoint: `127.0.0.1:${String(telemetryPort)}`,
      enabled: true,
      tlsMode: "disabled",
    },
    registry,
    store,
  );
  const engine = new ClimateExecutionEngine(store, registry, rest, telemetry, 3000);
  ws = new HomeAssistantClimateWebSocket({
    baseUrl: fake.url,
    token: fake.token,
    entityIds: registry.entityIds(),
    reconnectMinMs: 20,
    reconnectMaxMs: 100,
  });
  ws.onState((state) => void engine.observe(normalizeClimateState("e2e-climate", state)));
  provider = new ClimateProviderServer(
    {
      providerId: "home-assistant-climate",
      providerVersion: "0.1.0",
      host: "127.0.0.1",
      port: 0,
      tlsMode: "disabled",
    },
    registry,
    rest,
    store,
    engine,
  );
  const providerPort = await provider.start();
  runtime = createRuntime(
    loadRuntimeConfig({
      DATABASE_URL: databaseUrl,
      PROVIDER_ID: "home-assistant-climate",
      ADAPTER_ENDPOINT: `127.0.0.1:${String(providerPort)}`,
      AUTH_MODE: "trusted_headers",
      LOG_LEVEL: "warn",
      PROVIDER_TELEMETRY_INGRESS_ENABLED: "true",
      PROVIDER_TELEMETRY_HOST: "127.0.0.1",
      PROVIDER_TELEMETRY_PORT: String(telemetryPort),
      PROVIDER_TELEMETRY_TLS_MODE: "disabled",
      SCHEDULER_POLL_MS: "100",
      RECOVERY_POLL_MS: "500",
      ADAPTER_HEALTH_POLL_MS: "100",
    }),
  );
  await runtime.initialize();
  await runtime.app.listen({ host: "127.0.0.1", port: 0 });
  const address = runtime.app.server.address();
  if (address === null || typeof address === "string") throw new Error("RUNTIME_BIND_FAILED");
  client = new Client({ name: "climate-e2e", version: "1.0.0" });
  await client.connect(
    new StreamableHTTPClientTransport(new URL(`http://127.0.0.1:${String(address.port)}/mcp`), {
      requestInit: { headers: { "x-sdar-subject": "e2e-user", "x-sdar-tenant": "e2e-tenant" } },
    }) as unknown as Transport,
  );
  telemetry.start();
  ws.start();
});
afterAll(async () => {
  ws.stop();
  telemetry.stop();
  await client.close();
  await runtime.app.close();
  await provider.close();
  await fake.close();
  await pool.end();
});
describe("Home Assistant climate Runtime E2E", () => {
  it("publishes four tools, completes temperature control once, and records telemetry", async () => {
    expect((await client.listTools()).tools.map((t) => t.name)).toEqual([
      "climate_get_state",
      "climate_set_power",
      "climate_set_hvac_mode",
      "climate_set_temperature",
    ]);
    expect(
      await client.callTool({
        name: "climate_get_state",
        arguments: { resourceId: "e2e-climate" },
      }),
    ).toMatchObject({
      isError: false,
      structuredContent: { resourceId: "e2e-climate", power: "off" },
    });
    const request = {
      method: "tools/call" as const,
      params: {
        name: "climate_set_temperature",
        arguments: { resourceId: "e2e-climate", targetTemperature: 22 },
        _meta: { "io.sdar/taskExecution": { idempotencyKey: "climate-e2e-temperature" } },
      },
    };
    const created = await client.request(request, CreateTaskResultSchema, { task: { ttl: 60000 } });
    await wait(
      async () =>
        (await client.experimental.tasks.getTask(created.task.taskId)).status === "completed",
    );
    const duplicate = await client.request(request, CreateTaskResultSchema, {
      task: { ttl: 60000 },
    });
    expect(duplicate.task.taskId).toBe(created.task.taskId);
    expect(fake.serviceCalls).toHaveLength(1);
    await wait(async () => {
      const result = await pool.query<{ count: string }>(
        "SELECT count(*) AS count FROM provider_ops_delivery",
      );
      return Number(result.rows[0]?.count ?? 0) >= 4;
    });
  });
});
async function freePort(): Promise<number> {
  const s = createServer();
  await new Promise<void>((resolve) => s.listen(0, "127.0.0.1", resolve));
  const a = s.address();
  if (a === null || typeof a === "string") throw new Error("PORT_FAILED");
  const p = a.port;
  await new Promise<void>((resolve) => s.close(() => resolve()));
  return p;
}
async function wait(fn: () => Promise<boolean>, timeout = 5000): Promise<void> {
  const end = Date.now() + timeout;
  while (Date.now() < end) {
    if (await fn()) return;
    await new Promise((resolve) => setTimeout(resolve, 50));
  }
  throw new Error("WAIT_TIMEOUT");
}
