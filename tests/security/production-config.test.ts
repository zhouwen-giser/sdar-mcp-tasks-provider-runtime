import { describe, expect, it } from "vitest";
import { loadRuntimeConfig, parseBooleanEnv } from "../../apps/runtime/src/config.js";

describe("H4 production fail-closed configuration", () => {
  it.each([
    ["true", true],
    ["TRUE", true],
    ["1", true],
    ["false", false],
    ["FALSE", false],
    ["0", false],
  ] as const)("parses boolean environment value %s", (input, expected) => {
    expect(parseBooleanEnv(input)).toBe(expected);
  });

  it("rejects ambiguous boolean values", () => {
    expect(() => parseBooleanEnv("abc")).toThrow("INVALID_BOOLEAN_ENV:abc");
    expect(() => loadRuntimeConfig({ ALLOW_WEAK_LEASE_CONFIGURATION: "abc" })).toThrow(
      "INVALID_BOOLEAN_ENV:abc",
    );
  });

  it("rejects development auth, plaintext Adapter transport, and weak leases in production", () => {
    expect(() => loadRuntimeConfig({ RUNTIME_ENV: "production" })).toThrow(
      "production forbids development auth",
    );
    expect(() =>
      loadRuntimeConfig({
        RUNTIME_ENV: "production",
        AUTH_MODE: "trusted_headers",
      }),
    ).toThrow("production requires Adapter mTLS");
    expect(() =>
      loadRuntimeConfig({
        ...secureProduction(),
        ALLOW_WEAK_LEASE_CONFIGURATION: "true",
      }),
    ).toThrow("production forbids weak lease configuration");
  });

  it("accepts explicit fail-closed production configuration", () => {
    expect(loadRuntimeConfig(secureProduction())).toMatchObject({
      RUNTIME_ENV: "production",
      AUTH_MODE: "trusted_headers",
      ADAPTER_TLS_MODE: "required",
      ALLOW_WEAK_LEASE_CONFIGURATION: false,
    });
  });

  it("requires a configured webhook and HTTPS in production", () => {
    expect(() => loadRuntimeConfig({ OUTBOX_SINK: "webhook" })).toThrow(
      "webhook Outbox requires OUTBOX_WEBHOOK_URL",
    );
    expect(() =>
      loadRuntimeConfig({
        ...secureProduction(),
        OUTBOX_SINK: "webhook",
        OUTBOX_WEBHOOK_URL: "http://events.example.test/outbox",
      }),
    ).toThrow("production Outbox webhook requires HTTPS");
  });
});

function secureProduction(): NodeJS.ProcessEnv {
  return {
    RUNTIME_ENV: "production",
    AUTH_MODE: "trusted_headers",
    ADAPTER_TLS_MODE: "required",
    ADAPTER_TLS_CA_PATH: "/run/secrets/ca.pem",
    ADAPTER_TLS_CERT_PATH: "/run/secrets/client.pem",
    ADAPTER_TLS_KEY_PATH: "/run/secrets/client-key.pem",
    ALLOW_WEAK_LEASE_CONFIGURATION: "false",
  };
}
