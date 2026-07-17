import {
  AggregationTemporality,
  InMemoryMetricExporter,
  PeriodicExportingMetricReader,
} from "@opentelemetry/sdk-metrics";
import { describe, expect, it } from "vitest";
import { ProviderTelemetry } from "../../packages/observability/src/index.js";

const resource = {
  serviceVersion: "1.1.0",
  instanceId: "runtime-metrics",
  deploymentEnvironment: "test",
  providerId: "metrics-provider",
  providerVersion: "1.0.0",
};

describe("Provider OTel metrics", () => {
  it("exports the required instruments with bounded low-cardinality labels", async () => {
    const exporter = new InMemoryMetricExporter(AggregationTemporality.CUMULATIVE);
    const telemetry = new ProviderTelemetry({
      resource,
      enabled: true,
      metricReader: new PeriodicExportingMetricReader({
        exporter,
        exportIntervalMillis: 60_000,
      }),
    });
    telemetry.start();

    for (const name of [
      "provider_task_transition_total",
      "provider_command_total",
      "adapter_rpc_total",
      "provider_error_total",
      "provider_recovery_total",
    ]) {
      telemetry.metric(name, 2, {
        method: "startOperation",
        outcome: "success",
        taskId: "must-not-be-a-label",
        argumentHash: "must-not-be-a-label",
        userId: "must-not-be-a-label",
      });
    }
    for (const name of [
      "adapter_rpc_duration",
      "command_dispatch_duration",
      "task_transition_duration",
      "recovery_duration",
    ]) {
      telemetry.metric(name, 12.5, { outcome: "success" }, "histogram");
    }
    for (const name of ["active_tasks", "pending_commands", "outbox_pending", "recovery_backlog"]) {
      telemetry.metric(name, 3, {}, "gauge");
    }

    await telemetry.shutdown();

    const metrics = exporter
      .getMetrics()
      .flatMap((batch) => batch.scopeMetrics)
      .flatMap((scope) => scope.metrics);
    expect(new Set(metrics.map((metric) => metric.descriptor.name))).toEqual(
      new Set([
        "provider_task_transition_total",
        "provider_command_total",
        "adapter_rpc_total",
        "provider_error_total",
        "provider_recovery_total",
        "adapter_rpc_duration",
        "command_dispatch_duration",
        "task_transition_duration",
        "recovery_duration",
        "active_tasks",
        "pending_commands",
        "outbox_pending",
        "recovery_backlog",
      ]),
    );
    const counter = metrics.find(
      (metric) => metric.descriptor.name === "provider_task_transition_total",
    );
    expect(counter?.dataPoints[0]).toMatchObject({
      value: 2,
      attributes: { method: "startOperation", outcome: "success" },
    });
    expect(counter?.dataPoints[0]?.attributes).not.toHaveProperty("taskId");
    expect(counter?.dataPoints[0]?.attributes).not.toHaveProperty("argumentHash");
    expect(counter?.dataPoints[0]?.attributes).not.toHaveProperty("userId");
  });
});
