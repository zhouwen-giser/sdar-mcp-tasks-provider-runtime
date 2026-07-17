import { InMemoryLogRecordExporter } from "@opentelemetry/sdk-logs";
import { InMemorySpanExporter } from "@opentelemetry/sdk-trace-node";
import { describe, expect, it } from "vitest";
import { ProviderTelemetry } from "../../packages/observability/src/index.js";

const resource = {
  serviceVersion: "1.1.0",
  instanceId: "runtime-test-1",
  deploymentEnvironment: "test",
  providerId: "telemetry-provider",
  providerVersion: "1.0.0",
};

describe("ProviderTelemetry initialization", () => {
  it("starts once and records traces and events", async () => {
    const spans = new RetainingSpanExporter();
    const events = new RetainingLogExporter();
    const telemetry = new ProviderTelemetry({
      resource,
      enabled: true,
      spanExporter: spans,
      eventExporter: events,
      batch: { scheduledDelayMillis: 60_000 },
    });

    telemetry.start();
    telemetry.start();
    await expect(
      telemetry.trace("provider.test", { outcome: "ok" }, () => Promise.resolve(42)),
    ).resolves.toBe(42);
    telemetry.event("provider.test_event", { outcome: "ok" });
    await telemetry.shutdown();

    expect(spans.getFinishedSpans()).toHaveLength(1);
    expect(events.getFinishedLogRecords()).toHaveLength(1);
  });

  it("is a no-op when disabled", async () => {
    const telemetry = new ProviderTelemetry({ resource });
    telemetry.start();
    await expect(
      telemetry.trace("provider.disabled", {}, () => Promise.resolve("ok")),
    ).resolves.toBe("ok");
    telemetry.event("provider.disabled", { secret: "not exported" });
    telemetry.metric("provider_disabled_total");
    await telemetry.shutdown();
  });
});

class RetainingSpanExporter extends InMemorySpanExporter {
  override shutdown(): Promise<void> {
    return Promise.resolve();
  }
}

class RetainingLogExporter extends InMemoryLogRecordExporter {
  override shutdown(): Promise<void> {
    return Promise.resolve();
  }
}
