import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { loadConfig } from "../../apps/home-assistant-light-provider/src/config.js";
import {
  haBrightnessToPercent,
  normalizeLightState,
  percentToHaBrightness,
} from "../../apps/home-assistant-light-provider/src/home-assistant/state-normalizer.js";
import { loadResourceConfig } from "../../apps/home-assistant-light-provider/src/resources/resource-config.js";
import { stableProviderEventId } from "../../apps/home-assistant-light-provider/src/telemetry/event-builder.js";
import { DurableTelemetryQueue } from "../../apps/home-assistant-light-provider/src/telemetry/durable-queue.js";
import { MemoryExecutionStore } from "../../apps/home-assistant-light-provider/src/execution/execution-store.js";

describe("Home Assistant light Provider core", () => {
  it("parses secure config and rejects token environment variables and production HTTP", () => {
    const directory = mkdtempSync(join(tmpdir(), "ha-light-config-"));
    const tokenFile = join(directory, "token");
    writeFileSync(tokenFile, "secret\n");
    const base = {
      HOME_ASSISTANT_URL: "http://127.0.0.1:8123",
      HOME_ASSISTANT_TOKEN_FILE: tokenFile,
      LIGHT_RESOURCES_FILE: join(directory, "lights.json"),
      PROVIDER_STATE_PATH: join(directory, "state.json"),
      RUNTIME_ENV: "test",
    };
    expect(loadConfig(base).homeAssistantToken).toBe("secret");
    expect(() => loadConfig({ ...base, HOME_ASSISTANT_TOKEN: "forbidden" })).toThrow(
      "HOME_ASSISTANT_TOKEN_ENVIRONMENT_FORBIDDEN",
    );
    expect(() => loadConfig({ ...base, RUNTIME_ENV: "production" })).toThrow(
      "HOME_ASSISTANT_INSECURE_HTTP_FORBIDDEN",
    );
    expect(
      loadConfig({ ...base, RUNTIME_ENV: "production", HOME_ASSISTANT_ALLOW_INSECURE_HTTP: "true" })
        .HOME_ASSISTANT_ALLOW_INSECURE_HTTP,
    ).toBe(true);
  });

  it("validates unique light-domain resources", () => {
    const directory = mkdtempSync(join(tmpdir(), "ha-light-resource-"));
    const path = join(directory, "lights.json");
    writeFileSync(
      path,
      JSON.stringify({
        resources: [
          {
            resourceId: "light-1",
            entityId: "light.living_room",
            displayName: "Living room",
            enabled: true,
            expectedCapabilities: { power: true, brightness: true },
          },
        ],
      }),
    );
    expect(loadResourceConfig(path)[0]?.entityId).toBe("light.living_room");
    writeFileSync(
      path,
      JSON.stringify({
        resources: [
          {
            resourceId: "light-1",
            entityId: "switch.bad",
            displayName: "Bad",
            enabled: true,
            expectedCapabilities: { power: true, brightness: false },
          },
        ],
      }),
    );
    expect(() => loadResourceConfig(path)).toThrow();
  });

  it("normalizes states and converts brightness at bounded values", () => {
    expect(percentToHaBrightness(50)).toBe(128);
    expect(haBrightnessToPercent(128)).toBe(50);
    const normalized = normalizeLightState("light-1", {
      entity_id: "light.internal",
      state: "on",
      attributes: { brightness: 128, supported_color_modes: ["brightness"] },
      last_changed: "2026-07-18T00:00:00.000Z",
      last_updated: "2026-07-18T00:00:00.000Z",
    });
    expect(normalized).toMatchObject({
      resourceId: "light-1",
      power: "on",
      reachable: true,
      brightnessPercent: 50,
      supportsBrightness: true,
    });
    expect(
      normalizeLightState("light-1", {
        entity_id: "light.internal",
        state: "unavailable",
        attributes: {},
        last_changed: "2026-07-18T00:00:00.000Z",
        last_updated: "2026-07-18T00:00:00.000Z",
      }),
    ).toMatchObject({ power: "unavailable", reachable: false, brightnessPercent: null });
  });

  it("builds stable telemetry ids and coalesces metrics", () => {
    const payload = { metricName: "brightness", value: 40, unit: "percent", quality: "observed" };
    expect(
      stableProviderEventId("provider", "light.internal", "time", "RESOURCE_METRIC", payload),
    ).toBe(
      stableProviderEventId("provider", "light.internal", "time", "RESOURCE_METRIC", {
        quality: "observed",
        unit: "percent",
        value: 40,
        metricName: "brightness",
      }),
    );
    const store = new MemoryExecutionStore();
    const queue = new DurableTelemetryQueue(store, 10);
    const base = {
      providerEventId: "one",
      eventType: "RESOURCE_METRIC" as const,
      resourceId: "light-1",
      resourceType: "home_assistant.light",
      taskId: "",
      externalExecutionId: "",
      operationName: "",
      attributes: {},
      payload,
      traceparent: "",
      tracestate: "",
    };
    queue.enqueue(base);
    queue.enqueue({ ...base, providerEventId: "two", payload: { ...payload, value: 50 } });
    expect(queue.size()).toBe(1);
    expect(queue.ready()[0]?.event.providerEventId).toBe("two");
  });
});
