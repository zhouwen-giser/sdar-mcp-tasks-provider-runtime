import { describe, expect, it } from "vitest";
import { loadRuntimeConfig } from "../../apps/runtime/src/config.js";

describe("Runtime configuration", () => {
  it("provides bounded production-shaped defaults", () => {
    const config = loadRuntimeConfig({});
    expect(config.PORT).toBe(8080);
    expect(config.PROVIDER_ID).toBe("mock-provider");
    expect(config.ADAPTER_TLS_MODE).toBe("disabled");
    expect(config.ADAPTER_RPC_TIMEOUT_MS).toBe(5_000);
  });

  it("rejects invalid ports and timeouts", () => {
    expect(() => loadRuntimeConfig({ PORT: "70000" })).toThrow();
    expect(() => loadRuntimeConfig({ ADAPTER_RPC_TIMEOUT_MS: "0" })).toThrow();
  });
});
