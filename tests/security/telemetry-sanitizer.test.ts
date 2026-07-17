import { InMemoryLogRecordExporter } from "@opentelemetry/sdk-logs";
import { InMemorySpanExporter } from "@opentelemetry/sdk-trace-node";
import { describe, expect, it } from "vitest";
import { ProviderTelemetry, TelemetrySanitizer } from "../../packages/observability/src/index.js";

describe("TelemetrySanitizer", () => {
  it("removes secrets and raw arguments while retaining approved hashes and execution context", () => {
    const sanitized = new TelemetrySanitizer().sanitize({
      password: "classified-password",
      token: "classified-token",
      authorization: "Bearer classified-authorization",
      jwt: "classified-jwt",
      arguments: { resourceId: "classified-argument" },
      inputs: [{ value: "classified-input" }],
      adapterPayload: { response: "classified-adapter-payload" },
      argumentHash: "argument-hash-safe",
      authorizationContextHash: "authorization-hash-safe",
      simulationId: "simulation-safe",
      executionMode: "simulation",
    });

    const output = JSON.stringify(sanitized);
    expect(output).not.toMatch(/classified|password|token|arguments|adapterPayload/);
    expect(sanitized).toMatchObject({
      argumentHash: "argument-hash-safe",
      authorizationContextHash: "authorization-hash-safe",
      simulationId: "simulation-safe",
      executionMode: "simulation",
    });
  });

  it("sanitizes exported event bodies and trace attributes", async () => {
    const events = new RetainingLogExporter();
    const spans = new RetainingSpanExporter();
    const telemetry = new ProviderTelemetry({
      resource: {
        serviceVersion: "1.1.0",
        instanceId: "runtime-sanitizer",
        deploymentEnvironment: "test",
        providerId: "sanitizer-provider",
        providerVersion: "1.0.0",
      },
      enabled: true,
      eventExporter: events,
      spanExporter: spans,
      batch: { scheduledDelayMillis: 60_000 },
    });
    telemetry.start();
    telemetry.event("provider.security", {
      token: "event-secret",
      arguments: { resourceId: "argument-secret" },
      argumentHash: "hash-exported",
    });
    await telemetry.trace(
      "provider.security_trace",
      { authorization: "Bearer trace-secret", authorizationContextHash: "auth-hash-exported" },
      () => Promise.resolve(undefined),
    );
    await telemetry.shutdown();

    const output = JSON.stringify({
      body: events.getFinishedLogRecords()[0]?.body,
      attributes: spans.getFinishedSpans()[0]?.attributes,
    });
    expect(output).not.toMatch(/event-secret|argument-secret|trace-secret/);
    expect(output).toContain("hash-exported");
    expect(output).toContain("auth-hash-exported");
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
