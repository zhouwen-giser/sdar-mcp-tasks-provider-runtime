import { createServer } from "node:net";
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
let runtimeUrl: URL;
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
      SCHEDULER_POLL_MS: "5000",
      RECOVERY_POLL_MS: "5000",
      ADAPTER_HEALTH_POLL_MS: "100",
    }),
  );
  await runtime.initialize();
  await runtime.app.listen({ host: "127.0.0.1", port: 0 });
  const address = runtime.app.server.address();
  if (address === null || typeof address === "string") throw new Error("RUNTIME_BIND_FAILED");
  runtimeUrl = new URL(`http://127.0.0.1:${String(address.port)}/mcp`);
  telemetry.start();
  websocket.start();
});

afterAll(async () => {
  websocket.stop();
  telemetry.stop();
  await runtime.app.close();
  await provider.close();
  await fake.close();
  await pool.end();
});

describe("Home Assistant light Runtime E2E", () => {
  it("uses frozen discovery, flat Tasks, Ack-first notifications and actual-state Evidence", async () => {
    const discovery = await frozenRequest("server/discover", {}, 1);
    expect(discovery.statusCode).toBe(200);
    expect(discovery.json<{ result: Record<string, unknown> }>().result).toMatchObject({
      resultType: "complete",
      supportedVersions: ["2026-07-28"],
      capabilities: { extensions: { "io.modelcontextprotocol/tasks": {} } },
    });

    const toolsResponse = await frozenRequest("tools/list", {}, 2);
    const tools = toolsResponse.json<{ result: { tools: Record<string, unknown>[] } }>().result
      .tools;
    expect(tools.map((tool) => tool.name)).toEqual([
      "light_get_state",
      "light_set_power",
      "light_set_brightness",
    ]);
    expect(tools.map(taskBehavior)).toEqual(["synchronous_only", "task_required", "task_required"]);

    const stateResponse = await frozenRequest(
      "tools/call",
      { name: "light_get_state", arguments: { resourceId: "e2e-light" } },
      3,
      "light_get_state",
    );
    expect(stateResponse.json<{ result: Record<string, unknown> }>().result).toMatchObject({
      resultType: "complete",
      isError: false,
      structuredContent: { resourceId: "e2e-light", power: "off" },
      _meta: {
        "io.sdar/evidence": {
          profileVersion: "1.0",
          items: [
            expect.objectContaining({
              evidenceType: "light.state.observation",
              payloadRef: { kind: "structured_content", jsonPointer: "/power" },
            }),
          ],
        },
      },
    });

    fake.applyDelayMs = 300;
    const taskMeta = {
      "io.sdar/taskExecution": {
        profileVersion: "1.0",
        idempotencyKey: "ha-light-e2e-power",
      },
    };
    const createResponse = await frozenRequest(
      "tools/call",
      { name: "light_set_power", arguments: { resourceId: "e2e-light", power: "on" } },
      4,
      "light_set_power",
      taskMeta,
    );
    const created = createResponse.json<{ result: Record<string, unknown> }>().result;
    expect(created).toMatchObject({ resultType: "task", status: "working" });
    expect(created).not.toHaveProperty("task");
    const taskId = String(created.taskId);

    const subscription = await openFrozenSubscription(runtimeUrl, taskId, "ha-light-subscription");
    const acknowledgement = await subscription.next();
    expect(acknowledgement).toMatchObject({
      method: "notifications/subscriptions/acknowledged",
      params: { notifications: { taskIds: [taskId] } },
    });
    const working = await subscription.nextUntil(
      (message) =>
        message.method === "notifications/tasks" &&
        (message.params as Record<string, unknown>).status === "working",
    );
    expect(working).toBeDefined();
    const completedMessage = await subscription.nextUntil(
      (message) =>
        message.method === "notifications/tasks" &&
        (message.params as Record<string, unknown>).status === "completed",
    );
    const completedTask = completedMessage.params as Record<string, unknown>;
    const getResponse = await frozenRequest("tasks/get", { taskId }, 5, taskId);
    const authoritative = getResponse.json<{ result: Record<string, unknown> }>().result;
    expect(normalizeNotificationTask(completedTask)).toEqual(normalizeGetTask(authoritative));
    expect(completedTask).toMatchObject({
      result: {
        resultType: "complete",
        structuredContent: { resourceId: "e2e-light", power: "on", confirmed: true },
        _meta: {
          "io.sdar/evidence": {
            profileVersion: "1.0",
            items: [
              expect.objectContaining({
                evidenceType: "light.state.observation",
                payloadRef: { kind: "structured_content", jsonPointer: "/power" },
              }),
            ],
          },
        },
      },
    });
    expect(JSON.stringify(completedTask)).not.toContain("requirementId");
    await subscription.close();

    const duplicateResponse = await frozenRequest(
      "tools/call",
      { name: "light_set_power", arguments: { resourceId: "e2e-light", power: "on" } },
      6,
      "light_set_power",
      taskMeta,
    );
    expect(duplicateResponse.json<{ result: Record<string, unknown> }>().result).toMatchObject({
      taskId,
    });
    expect(fake.serviceCalls).toHaveLength(1);
    await waitFor(async () => {
      const result = await pool.query<{ count: string }>(
        "SELECT count(*) AS count FROM provider_ops_delivery",
      );
      return Number(result.rows[0]?.count ?? 0) >= 4;
    });
  });
});

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
    headers: frozenHeaders(method, name),
    payload: {
      jsonrpc: "2.0",
      id,
      method,
      params: { ...params, _meta: { ...frozenMeta(), ...extraMeta } },
    },
  });
}

function frozenHeaders(method: string, name?: string): Record<string, string> {
  return {
    accept: "application/json, text/event-stream",
    "content-type": "application/json",
    "mcp-protocol-version": "2026-07-28",
    "mcp-method": method,
    ...(name === undefined ? {} : { "mcp-name": name }),
    "x-sdar-subject": "e2e-user",
    "x-sdar-tenant": "e2e-tenant",
  };
}

function frozenMeta(): Record<string, unknown> {
  return {
    "io.modelcontextprotocol/protocolVersion": "2026-07-28",
    "io.modelcontextprotocol/clientInfo": { name: "ha-light-e2e", version: "1.0.0" },
    "io.modelcontextprotocol/clientCapabilities": {
      extensions: { "io.modelcontextprotocol/tasks": {} },
    },
  };
}

async function openFrozenSubscription(url: URL, taskId: string, requestId: string) {
  const controller = new AbortController();
  const response = await fetch(url, {
    method: "POST",
    signal: controller.signal,
    headers: frozenHeaders("subscriptions/listen"),
    body: JSON.stringify({
      jsonrpc: "2.0",
      id: requestId,
      method: "subscriptions/listen",
      params: { notifications: { taskIds: [taskId] }, _meta: frozenMeta() },
    }),
  });
  expect(response.status).toBe(200);
  const reader = response.body?.getReader();
  if (reader === undefined) throw new Error("SSE_RESPONSE_BODY_MISSING");
  const decoder = new TextDecoder();
  let buffer = "";
  const messages: Record<string, unknown>[] = [];
  const next = async (): Promise<Record<string, unknown>> => {
    const deadline = Date.now() + 10_000;
    for (;;) {
      const queued = messages.shift();
      if (queued !== undefined) return queued;
      const remaining = deadline - Date.now();
      if (remaining <= 0) throw new Error(`SSE_MESSAGE_TIMEOUT:${requestId}`);
      const read = await withTimeout(reader.read(), remaining);
      if (read.done) throw new Error(`SSE_STREAM_CLOSED:${requestId}`);
      const chunk: unknown = read.value;
      if (!(chunk instanceof Uint8Array)) throw new Error(`SSE_BYTES_INVALID:${requestId}`);
      buffer += decoder.decode(chunk, { stream: true });
      for (;;) {
        const boundary = buffer.indexOf("\n\n");
        if (boundary < 0) break;
        const frame = buffer.slice(0, boundary);
        buffer = buffer.slice(boundary + 2);
        const data = frame
          .split("\n")
          .filter((line) => line.startsWith("data: "))
          .map((line) => line.slice(6))
          .join("\n");
        if (data.length === 0) continue;
        messages.push(JSON.parse(data) as Record<string, unknown>);
      }
    }
  };
  return {
    next,
    async nextUntil(predicate: (message: Record<string, unknown>) => boolean) {
      for (;;) {
        const message = await next();
        if (predicate(message)) return message;
      }
    },
    async close() {
      controller.abort();
      await reader.cancel().catch(() => undefined);
    },
  };
}

function normalizeNotificationTask(task: Record<string, unknown>): Record<string, unknown> {
  const value = structuredClone(task);
  const meta = value._meta as Record<string, Record<string, unknown>>;
  delete meta["io.modelcontextprotocol/subscriptionId"];
  const execution = meta["io.sdar/taskExecution"];
  if (execution !== undefined) {
    delete execution.eventId;
    delete execution.observedAt;
  }
  return value;
}

function normalizeGetTask(task: Record<string, unknown>): Record<string, unknown> {
  const value = structuredClone(task);
  delete value.resultType;
  return value;
}

function taskBehavior(tool: Record<string, unknown>): unknown {
  const meta = tool._meta;
  if (typeof meta !== "object" || meta === null || Array.isArray(meta)) return undefined;
  const profile = (meta as Record<string, unknown>)["io.sdar/taskExecution"];
  if (typeof profile !== "object" || profile === null || Array.isArray(profile)) return undefined;
  return (profile as Record<string, unknown>).taskBehavior;
}

function withTimeout<T>(promise: Promise<T>, timeoutMs: number): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error("SSE_READ_TIMEOUT")), timeoutMs);
    void promise.then(
      (value) => {
        clearTimeout(timer);
        resolve(value);
      },
      (error: unknown) => {
        clearTimeout(timer);
        reject(error instanceof Error ? error : new Error(String(error)));
      },
    );
  });
}

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
