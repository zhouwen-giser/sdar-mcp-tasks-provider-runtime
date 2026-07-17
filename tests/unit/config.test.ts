import { describe, expect, it } from "vitest";
import { loadRuntimeConfig } from "../../apps/runtime/src/config.js";

describe("Runtime configuration", () => {
  it("provides bounded production-shaped defaults", () => {
    const config = loadRuntimeConfig({});
    expect(config.PORT).toBe(8080);
    expect(config.PROVIDER_ID).toBe("mock-provider");
    expect(config.ADAPTER_TLS_MODE).toBe("disabled");
    expect(config.ADAPTER_RPC_TIMEOUT_MS).toBe(5_000);
    expect(config.AUTH_MODE).toBe("development");
    expect(config.HTTP_BODY_LIMIT_BYTES).toBe(1_048_576);
    expect(config.RATE_LIMIT_MAX_KEYS).toBe(10_000);
    expect(config.DATABASE_POOL_MAX).toBe(10);
    expect(config.ADAPTER_HEALTH_FAILURE_THRESHOLD).toBe(2);
    expect(config.OUTBOX_PUBLISHED_RETENTION_MS).toBe(86_400_000);
  });

  it("rejects invalid ports and timeouts", () => {
    expect(() => loadRuntimeConfig({ PORT: "70000" })).toThrow();
    expect(() => loadRuntimeConfig({ ADAPTER_RPC_TIMEOUT_MS: "0" })).toThrow();
    expect(() => loadRuntimeConfig({ ADAPTER_ENDPOINT: "file:///tmp/adapter.sock" })).toThrow();
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
  });

  it("validates outbox published retention bounds", () => {
    expect(loadRuntimeConfig({}).OUTBOX_PUBLISHED_RETENTION_MS).toBe(86_400_000);
    expect(() => loadRuntimeConfig({ OUTBOX_PUBLISHED_RETENTION_MS: "59999" })).toThrow();
    expect(loadRuntimeConfig({ OUTBOX_PUBLISHED_RETENTION_MS: "60000" }).OUTBOX_PUBLISHED_RETENTION_MS).toBe(
      60_000,
    );
    expect(loadRuntimeConfig({ OUTBOX_PUBLISHED_RETENTION_MS: "7776000000" }).OUTBOX_PUBLISHED_RETENTION_MS).toBe(
      7_776_000_000,
    );
    expect(() => loadRuntimeConfig({ OUTBOX_PUBLISHED_RETENTION_MS: "7776000001" })).toThrow();
  });
});
