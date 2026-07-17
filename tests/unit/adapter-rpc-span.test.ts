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

describe("Adapter RPC spans", () => {
  it.each(["success", "error"] as const)(
    "records %s without request or response payloads",
    async (outcome) => {
      const exporter = new RetainingSpanExporter();
      const telemetry = new ProviderTelemetry({
        resource,
        enabled: true,
        spanExporter: exporter,
        batch: { scheduledDelayMillis: 60_000 },
      });
      telemetry.start();

      telemetry.adapterRpc("startOperation", outcome, 12.5, {
        taskId: "task-1",
        externalExecutionId: "execution-1",
        commandSequence: 7,
      });
      await telemetry.shutdown();

      const span = exporter.getFinishedSpans()[0];
      expect(span).toMatchObject({
        name: "adapter.rpc",
        attributes: {
          "adapter.provider": "telemetry-provider",
          "rpc.system": "grpc",
          "rpc.method": "startOperation",
          taskId: "task-1",
          externalExecutionId: "execution-1",
          commandSequence: 7,
          duration: 12.5,
          status: outcome,
        },
      });
      expect(JSON.stringify(span?.attributes)).not.toMatch(
        /request|response|argument|payload|token/i,
      );
    },
  );
});

class RetainingSpanExporter extends InMemorySpanExporter {
  override shutdown(): Promise<void> {
    return Promise.resolve();
  }
}
