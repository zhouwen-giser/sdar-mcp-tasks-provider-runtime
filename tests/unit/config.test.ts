import { describe, expect, it } from "vitest";
import { loadRuntimeConfig } from "../../apps/runtime/src/config.js";

describe("Runtime configuration", () => {
  it("provides bounded production-shaped defaults", () => {
    const config = loadRuntimeConfig({});
    expect(config.PORT).toBe(8080);
    expect(config.PROVIDER_ID).toBe("mock-provider");
    expect(config.OTEL_ENABLED).toBe(false);
    expect(config.OTEL_EXPORTER_OTLP_ENDPOINT).toBe("http://127.0.0.1:4318");
    expect(config.PROVIDER_TELEMETRY_INGRESS_ENABLED).toBe(false);
    expect(config.PROVIDER_TELEMETRY_PORT).toBe(7002);
    expect(config.PROVIDER_TELEMETRY_MAX_BATCH).toBe(100);
    expect(config.ADAPTER_TLS_MODE).toBe("disabled");
    expect(config.ADAPTER_RPC_TIMEOUT_MS).toBe(5_000);
    expect(config.AUTH_MODE).toBe("development");
    expect(config.HTTP_BODY_LIMIT_BYTES).toBe(1_048_576);
    expect(config.RATE_LIMIT_MAX_KEYS).toBe(10_000);
    expect(config.DATABASE_POOL_MAX).toBe(10);
    expect(config.ADAPTER_HEALTH_FAILURE_THRESHOLD).toBe(2);
    expect(config.ADAPTER_MANIFEST_POLL_MS).toBe(60_000);
    expect(config.COMMAND_DISPATCH_CONCURRENCY).toBe(8);
    expect(config.SCHEDULER_CONCURRENCY).toBe(8);
    expect(config.OUTBOX_SINK).toBe("internal_noop");
    expect(config.OUTBOX_BATCH_SIZE).toBe(100);
    expect(config.OUTBOX_PUBLISHED_RETENTION_MS).toBe(86_400_000);
  });

  it("parses opt-in OTLP configuration without making telemetry a readiness dependency", () => {
    const config = loadRuntimeConfig({
      OTEL_ENABLED: "true",
      OTEL_EXPORTER_OTLP_ENDPOINT: "https://collector.example.test:4318",
      OTEL_SERVICE_INSTANCE_ID: "runtime-a",
    });
    expect(config.OTEL_ENABLED).toBe(true);
    expect(config.OTEL_EXPORTER_OTLP_ENDPOINT).toBe("https://collector.example.test:4318");
    expect(config.OTEL_SERVICE_INSTANCE_ID).toBe("runtime-a");
  });

  it("rejects invalid ports and timeouts", () => {
    expect(() => loadRuntimeConfig({ PORT: "70000" })).toThrow();
    expect(() => loadRuntimeConfig({ ADAPTER_RPC_TIMEOUT_MS: "0" })).toThrow();
    expect(() => loadRuntimeConfig({ ADAPTER_ENDPOINT: "file:///tmp/adapter.sock" })).toThrow();
    expect(() => loadRuntimeConfig({ COMMAND_DISPATCH_CONCURRENCY: "0" })).toThrow();
    expect(() => loadRuntimeConfig({ SCHEDULER_CONCURRENCY: "129" })).toThrow();
  });

  it("requires complete mTLS and JWT secret configuration", () => {
    expect(() => loadRuntimeConfig({ ADAPTER_TLS_MODE: "required" })).toThrow(
      "mTLS requires CA, certificate, and key paths",
    );
    expect(() => loadRuntimeConfig({ AUTH_MODE: "jwt_hs256" })).toThrow(
      "jwt_hs256 requires JWT_HS256_SECRET",
    );
    expect(
      loadRuntimeConfig({
        ADAPTER_TLS_MODE: "required",
        ADAPTER_TLS_CA_PATH: "/run/secrets/ca.pem",
        ADAPTER_TLS_CERT_PATH: "/run/secrets/client.pem",
        ADAPTER_TLS_KEY_PATH: "/run/secrets/client-key.pem",
      }).ADAPTER_TLS_MODE,
    ).toBe("required");
    expect(() =>
      loadRuntimeConfig({
        PROVIDER_TELEMETRY_INGRESS_ENABLED: "true",
        PROVIDER_TELEMETRY_TLS_MODE: "required",
      }),
    ).toThrow("Provider telemetry mTLS requires CA, certificate, and key paths");
  });

  it("validates outbox published retention bounds", () => {
    expect(loadRuntimeConfig({}).OUTBOX_PUBLISHED_RETENTION_MS).toBe(86_400_000);
    expect(() => loadRuntimeConfig({ OUTBOX_PUBLISHED_RETENTION_MS: "59999" })).toThrow();
    expect(
      loadRuntimeConfig({ OUTBOX_PUBLISHED_RETENTION_MS: "60000" }).OUTBOX_PUBLISHED_RETENTION_MS,
    ).toBe(60_000);
    expect(
      loadRuntimeConfig({ OUTBOX_PUBLISHED_RETENTION_MS: "7776000000" })
        .OUTBOX_PUBLISHED_RETENTION_MS,
    ).toBe(7_776_000_000);
    expect(() => loadRuntimeConfig({ OUTBOX_PUBLISHED_RETENTION_MS: "7776000001" })).toThrow();
  });

  it("requires long RPC scenarios to raise command and idempotency leases", () => {
    expect(() => loadRuntimeConfig({ ADAPTER_RPC_TIMEOUT_MS: "20000" })).toThrow(
      "COMMAND_CLAIM_LEASE_MS must be >= 41500",
    );
    expect(
      loadRuntimeConfig({
        ADAPTER_RPC_TIMEOUT_MS: "20000",
        COMMAND_CLAIM_LEASE_MS: "60000",
        IDEMPOTENCY_LEASE_MS: "60000",
      }).leaseValidationMode,
    ).toBe("strict");
  });
});
