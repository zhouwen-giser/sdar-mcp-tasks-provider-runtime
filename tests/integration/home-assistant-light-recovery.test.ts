import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { FakeHomeAssistant } from "../fixtures/fake-home-assistant.js";
import { JsonExecutionStore } from "../../apps/home-assistant-light-provider/src/execution/execution-store.js";
import { executionSnapshot } from "../../apps/home-assistant-light-provider/src/execution/snapshots.js";
import { LightExecutionEngine } from "../../apps/home-assistant-light-provider/src/execution/execution-engine.js";
import { LightResourceRegistry } from "../../apps/home-assistant-light-provider/src/resources/registry.js";
import { HomeAssistantRestClient } from "../../apps/home-assistant-light-provider/src/home-assistant/rest-client.js";
import { NoopTelemetryService } from "../../apps/home-assistant-light-provider/src/telemetry/client.js";
import type { LightExecution } from "../../apps/home-assistant-light-provider/src/types.js";

describe("Home Assistant light execution recovery", () => {
  it("loads an atomically persisted pending execution and safely dispatches the desired state", async () => {
    const fake = new FakeHomeAssistant();
    fake.setState("light.recovery", "off", {});
    await fake.start();
    try {
      const path = join(mkdtempSync(join(tmpdir(), "ha-light-recovery-")), "state.json");
      const first = new JsonExecutionStore(path);
      const now = new Date();
      const execution: LightExecution = {
        taskId: "recovery-task",
        externalExecutionId: "external-recovery",
        operationName: "light_set_power",
        resourceId: "recovery-light",
        entityId: "light.recovery",
        argumentHash: "c".repeat(64),
        executionContext: {
          authorizationContextHash: "auth",
          executionMode: "LIVE",
          simulationId: "",
          correlationId: "correlation",
        },
        desiredState: { type: "power", power: "on" },
        state: "PENDING_SIDE_EFFECT",
        sideEffectDispatched: false,
        revision: 1,
        createdAt: now.toISOString(),
        updatedAt: now.toISOString(),
        confirmationDeadlineAt: new Date(now.getTime() + 2000).toISOString(),
        lastSnapshot: {},
        commandAcks: {},
      };
      execution.lastSnapshot = executionSnapshot(execution);
      first.set(execution);
      const restarted = new JsonExecutionStore(path);
      const engine = new LightExecutionEngine(
        restarted,
        new LightResourceRegistry([
          {
            resourceId: "recovery-light",
            entityId: "light.recovery",
            displayName: "Recovery",
            enabled: true,
            expectedCapabilities: { power: true, brightness: false },
          },
        ]),
        new HomeAssistantRestClient({ baseUrl: fake.url, token: fake.token, timeoutMs: 1000 }),
        new NoopTelemetryService(),
        2000,
      );
      await engine.recover();
      expect(fake.serviceCalls).toHaveLength(1);
      expect(restarted.get("recovery-task")?.state).toBe("CONFIRMING");
      await new Promise((resolve) => setTimeout(resolve, 30));
      await engine.poll("recovery-task");
      expect(restarted.get("recovery-task")?.state).toBe("SUCCEEDED");
    } finally {
      await fake.close();
    }
  });
});
