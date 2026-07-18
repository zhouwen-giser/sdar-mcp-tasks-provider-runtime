import { createServer } from "node:net";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import type { Transport } from "@modelcontextprotocol/sdk/shared/transport.js";
import { CreateTaskResultSchema } from "@modelcontextprotocol/sdk/types.js";
import { Pool } from "pg";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { loadRuntimeConfig } from "../../apps/runtime/src/config.js";
import { createRuntime, type RuntimeApplication } from "../../apps/runtime/src/runtime.js";
import { FakeHomeAssistant } from "../fixtures/fake-home-assistant.js";
import { HomeAssistantRestClient } from "../../apps/home-assistant-light-provider/src/home-assistant/rest-client.js";
import { HomeAssistantWebSocketClient } from "../../apps/home-assistant-light-provider/src/home-assistant/websocket-client.js";
import { normalizeLightState } from "../../apps/home-assistant-light-provider/src/home-assistant/state-normalizer.js";
import { LightResourceRegistry } from "../../apps/home-assistant-light-provider/src/resources/registry.js";
import { MemoryExecutionStore } from "../../apps/home-assistant-light-provider/src/execution/execution-store.js";
import { LightExecutionEngine } from "../../apps/home-assistant-light-provider/src/execution/execution-engine.js";
import { DurableTelemetryQueue } from "../../apps/home-assistant-light-provider/src/telemetry/durable-queue.js";
import { ProviderTelemetryClient } from "../../apps/home-assistant-light-provider/src/telemetry/client.js";
import { HomeAssistantLightProviderServer } from "../../apps/home-assistant-light-provider/src/server.js";

const databaseUrl = process.env.TEST_DATABASE_URL;
if (databaseUrl === undefined)
  throw new Error("TEST_DATABASE_URL is required for Home Assistant E2E tests");

let fake: FakeHomeAssistant;
let provider: HomeAssistantLightProviderServer;
let websocket: HomeAssistantWebSocketClient;
let telemetry: ProviderTelemetryClient;
let runtime: RuntimeApplication;
let client: Client;
let pool: Pool;

beforeAll(async () => {
  pool = new Pool({ connectionString: databaseUrl, max: 1 });
  await pool.query(`DROP TABLE IF EXISTS provider_ops_delivery, runtime_lease, outbox_event,
    idempotency_record, task_command, task_input_request, task_observation, provider_task,
    admission_intent, operation_snapshot, runtime_schema_migration CASCADE`);
  fake = new FakeHomeAssistant();
  fake.setState("light.e2e", "off", { brightness: 128, supported_color_modes: ["brightness"] });
  await fake.start();
  const telemetryPort = await freePort();
  const registry = new LightResourceRegistry([
    {
      resourceId: "e2e-light",
      entityId: "light.e2e",
      displayName: "E2E light",
      enabled: true,
      expectedCapabilities: { power: true, brightness: true },
    },
  ]);
  const rest = new HomeAssistantRestClient({
    baseUrl: fake.url,
    token: fake.token,
    timeoutMs: 1000,
  });
  const store = new MemoryExecutionStore();
  telemetry = new ProviderTelemetryClient(
    {
      providerId: "home-assistant-light",
      endpoint: `127.0.0.1:${String(telemetryPort)}`,
      enabled: true,
      tlsMode: "disabled",
    },
    registry,
    new DurableTelemetryQueue(store),
  );
  const engine = new LightExecutionEngine(store, registry, rest, telemetry, 3000);
  websocket = new HomeAssistantWebSocketClient({
    baseUrl: fake.url,
    token: fake.token,
    entityIds: registry.entityIds(),
    reconnectMinMs: 20,
    reconnectMaxMs: 100,
  });
  websocket.onState((state) => void engine.observe(normalizeLightState("e2e-light", state)));
  provider = new HomeAssistantLightProviderServer(
    {
      providerId: "home-assistant-light",
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
      PROVIDER_ID: "home-assistant-light",
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
  client = new Client({ name: "ha-light-e2e", version: "1.0.0" });
  await client.connect(
    new StreamableHTTPClientTransport(new URL(`http://127.0.0.1:${String(address.port)}/mcp`), {
      requestInit: { headers: { "x-sdar-subject": "e2e-user", "x-sdar-tenant": "e2e-tenant" } },
    }) as unknown as Transport,
  );
  telemetry.start();
  websocket.start();
});

afterAll(async () => {
  websocket.stop();
  telemetry.stop();
  await client.close();
  await runtime.app.close();
  await provider.close();
  await fake.close();
  await pool.end();
});

describe("Home Assistant light Runtime E2E", () => {
  it("publishes tools, completes the Task once, and records Provider telemetry", async () => {
    const tools = await client.listTools();
    expect(tools.tools.map((tool) => tool.name)).toEqual([
      "light_get_state",
      "light_set_power",
      "light_set_brightness",
    ]);
    const state = await client.callTool({
      name: "light_get_state",
      arguments: { resourceId: "e2e-light" },
    });
    expect(state).toMatchObject({
      isError: false,
      structuredContent: { resourceId: "e2e-light", power: "off" },
    });
    const request = {
      method: "tools/call" as const,
      params: {
        name: "light_set_power",
        arguments: { resourceId: "e2e-light", power: "on" },
        _meta: { "io.sdar/taskExecution": { idempotencyKey: "ha-light-e2e-power" } },
      },
    };
    const created = await client.request(request, CreateTaskResultSchema, {
      task: { ttl: 60_000 },
    });
    await waitFor(
      async () =>
        (await client.experimental.tasks.getTask(created.task.taskId)).status === "completed",
    );
    const duplicate = await client.request(request, CreateTaskResultSchema, {
      task: { ttl: 60_000 },
    });
    expect(duplicate.task.taskId).toBe(created.task.taskId);
    expect(fake.serviceCalls).toHaveLength(1);
    await waitFor(async () => {
      const result = await pool.query<{ count: string }>(
        "SELECT count(*) AS count FROM provider_ops_delivery",
      );
      return Number(result.rows[0]?.count ?? 0) >= 4;
    });
  });
});

async function freePort(): Promise<number> {
  const server = createServer();
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const address = server.address();
  if (address === null || typeof address === "string") throw new Error("PORT_ALLOCATION_FAILED");
  const port = address.port;
  await new Promise<void>((resolve) => server.close(() => resolve()));
  return port;
}
async function waitFor(predicate: () => Promise<boolean>, timeoutMs = 5000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (await predicate()) return;
    await new Promise((resolve) => setTimeout(resolve, 50));
  }
  throw new Error("WAIT_TIMEOUT");
}
