import { describe, expect, it } from "vitest";
import { FakeHomeAssistant } from "../fixtures/fake-home-assistant.js";
import { HomeAssistantRestClient } from "../../apps/home-assistant-light-provider/src/home-assistant/rest-client.js";
import { LightResourceRegistry } from "../../apps/home-assistant-light-provider/src/resources/registry.js";
import { LightExecutionEngine } from "../../apps/home-assistant-light-provider/src/execution/execution-engine.js";
import { MemoryExecutionStore } from "../../apps/home-assistant-light-provider/src/execution/execution-store.js";
import { NoopTelemetryService } from "../../apps/home-assistant-light-provider/src/telemetry/client.js";

describe("Home Assistant light Provider security", () => {
  it("does not expose bearer secrets in errors or persisted state", async () => {
    const fake = new FakeHomeAssistant();
    fake.setState("light.allowed", "off", {});
    await fake.start();
    try {
      fake.statusOverride = 401;
      const rest = new HomeAssistantRestClient({
        baseUrl: fake.url,
        token: fake.token,
        timeoutMs: 1000,
      });
      let message = "";
      try {
        await rest.getState("light.allowed");
      } catch (error) {
        message = String(error);
      }
      expect(message).toContain("HOME_ASSISTANT_UNAUTHORIZED");
      expect(message).not.toContain(fake.token);
    } finally {
      await fake.close();
    }
  });
  it("rejects an unconfigured resource before any Home Assistant side effect", async () => {
    const fake = new FakeHomeAssistant();
    fake.setState("light.allowed", "off", {});
    await fake.start();
    try {
      const engine = new LightExecutionEngine(
        new MemoryExecutionStore(),
        new LightResourceRegistry([
          {
            resourceId: "allowed",
            entityId: "light.allowed",
            displayName: "Allowed",
            enabled: true,
            expectedCapabilities: { power: true, brightness: false },
          },
        ]),
        new HomeAssistantRestClient({ baseUrl: fake.url, token: fake.token, timeoutMs: 1000 }),
        new NoopTelemetryService(),
        1000,
      );
      await expect(
        engine.start({
          taskId: "bad",
          operationName: "light_set_power",
          resourceId: "not-configured",
          power: "on",
          argumentHash: "d".repeat(64),
          executionContext: {
            authorizationContextHash: "auth",
            executionMode: "LIVE",
            simulationId: "",
            correlationId: "c",
          },
        }),
      ).rejects.toMatchObject({ reasonCode: "RESOURCE_NOT_CONFIGURED" });
      expect(fake.serviceCalls).toHaveLength(0);
    } finally {
      await fake.close();
    }
  });
});
