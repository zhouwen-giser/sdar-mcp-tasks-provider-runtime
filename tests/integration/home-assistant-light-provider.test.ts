import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { GrpcAdapterGateway } from "../../packages/adapter-protocol/src/index.js";
import { FakeHomeAssistant } from "../fixtures/fake-home-assistant.js";
import { HomeAssistantRestClient } from "../../apps/home-assistant-light-provider/src/home-assistant/rest-client.js";
import { HomeAssistantWebSocketClient } from "../../apps/home-assistant-light-provider/src/home-assistant/websocket-client.js";
import { normalizeLightState } from "../../apps/home-assistant-light-provider/src/home-assistant/state-normalizer.js";
import { LightResourceRegistry } from "../../apps/home-assistant-light-provider/src/resources/registry.js";
import { MemoryExecutionStore } from "../../apps/home-assistant-light-provider/src/execution/execution-store.js";
import { LightExecutionEngine } from "../../apps/home-assistant-light-provider/src/execution/execution-engine.js";
import { NoopTelemetryService } from "../../apps/home-assistant-light-provider/src/telemetry/client.js";
import { HomeAssistantLightProviderServer } from "../../apps/home-assistant-light-provider/src/server.js";

const resource = {
  resourceId: "living-room-main-light",
  entityId: "light.living_room_main",
  displayName: "Living room",
  enabled: true,
  expectedCapabilities: { power: true, brightness: true },
} as const;
let fake: FakeHomeAssistant;
let websocket: HomeAssistantWebSocketClient | undefined;
let server: HomeAssistantLightProviderServer | undefined;
let gateway: GrpcAdapterGateway | undefined;

beforeEach(async () => {
  fake = new FakeHomeAssistant();
  fake.setState(resource.entityId, "off", {
    brightness: 64,
    supported_color_modes: ["brightness"],
  });
  await fake.start();
});
afterEach(async () => {
  websocket?.stop();
  gateway?.close();
  if (server !== undefined) await server.close();
  await fake.close();
});

describe("Home Assistant light Provider Adapter", () => {
  it("exposes three operations and completes a power task once after observed confirmation", async () => {
    const { store, engine } = await startProvider();
    const manifest = await gateway?.describeProvider();
    expect(manifest?.operations.map((operation) => operation.name)).toEqual([
      "light_get_state",
      "light_set_power",
      "light_set_brightness",
    ]);
    const options = {
      taskId: "task-power-1",
      authorizationContextHash: "auth-hash",
      executionMode: "live" as const,
      argumentHash: "a".repeat(64),
    };
    const first = await gateway?.startOperation(
      "light_set_power",
      { resourceId: resource.resourceId, power: "on" },
      options,
    );
    expect(first?.accepted?.initialSnapshot.state).toMatch(/RUNNING|SUCCEEDED/);
    await waitFor(() => store.get("task-power-1")?.state === "SUCCEEDED");
    const duplicate = await gateway?.startOperation(
      "light_set_power",
      { resourceId: resource.resourceId, power: "on" },
      options,
    );
    expect(duplicate?.accepted?.initialSnapshot.state).toBe("SUCCEEDED");
    expect(fake.serviceCalls).toHaveLength(1);
    const execution = store.get("task-power-1");
    expect(execution?.revision).toBeGreaterThanOrEqual(3);
    const reconciled = await gateway?.reconcileExecution(
      "task-power-1",
      "light_set_power",
      "a".repeat(64),
      { ...options, externalExecutionId: execution?.externalExecutionId ?? "" },
    );
    expect(reconciled?.status).toBe("FOUND");
    expect(fake.serviceCalls).toHaveLength(1);
    await engine.poll("task-power-1");
    expect(store.get("task-power-1")?.state).toBe("SUCCEEDED");
  });

  it("maps brightness to HA 1-255 and confirms with REST polling while WebSocket is down", async () => {
    const { store, engine } = await startProvider();
    websocket?.stop();
    await gateway?.startOperation(
      "light_set_brightness",
      { resourceId: resource.resourceId, brightnessPercent: 50 },
      { taskId: "task-brightness", argumentHash: "b".repeat(64) },
    );
    expect(fake.serviceCalls[0]).toMatchObject({
      service: "turn_on",
      data: { entity_id: resource.entityId, brightness: 128 },
    });
    await waitFor(async () => {
      await engine.poll("task-brightness");
      return store.get("task-brightness")?.state === "SUCCEEDED";
    });
    expect(store.get("task-brightness")?.state).toBe("SUCCEEDED");
  });

  async function startProvider(): Promise<{
    store: MemoryExecutionStore;
    engine: LightExecutionEngine;
  }> {
    const registry = new LightResourceRegistry([resource]);
    const store = new MemoryExecutionStore();
    const rest = new HomeAssistantRestClient({
      baseUrl: fake.url,
      token: fake.token,
      timeoutMs: 1000,
    });
    const engine = new LightExecutionEngine(
      store,
      registry,
      rest,
      new NoopTelemetryService(),
      2000,
    );
    websocket = new HomeAssistantWebSocketClient({
      baseUrl: fake.url,
      token: fake.token,
      entityIds: registry.entityIds(),
      reconnectMinMs: 20,
      reconnectMaxMs: 100,
    });
    websocket.onState(
      (state) => void engine.observe(normalizeLightState(resource.resourceId, state)),
    );
    websocket.start();
    server = new HomeAssistantLightProviderServer(
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
    const port = await server.start();
    gateway = new GrpcAdapterGateway({
      endpoint: `127.0.0.1:${String(port)}`,
      providerId: "home-assistant-light",
    });
    await waitFor(() => true, 30);
    return { store, engine };
  }
});

async function waitFor(
  predicate: () => boolean | Promise<boolean>,
  timeoutMs = 3000,
): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (await predicate()) return;
    await new Promise((resolve) => setTimeout(resolve, 20));
  }
  throw new Error("WAIT_TIMEOUT");
}
