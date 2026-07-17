import { SpanStatusCode } from "@opentelemetry/api";
import type { Attributes } from "@opentelemetry/api";
import { OTLPLogExporter } from "@opentelemetry/exporter-logs-otlp-http";
import { OTLPMetricExporter } from "@opentelemetry/exporter-metrics-otlp-http";
import { OTLPTraceExporter } from "@opentelemetry/exporter-trace-otlp-http";
import { BatchLogRecordProcessor, LoggerProvider } from "@opentelemetry/sdk-logs";
import type { LogRecordExporter } from "@opentelemetry/sdk-logs";
import { MeterProvider, PeriodicExportingMetricReader } from "@opentelemetry/sdk-metrics";
import type { MetricReader } from "@opentelemetry/sdk-metrics";
import { BatchSpanProcessor, NodeTracerProvider } from "@opentelemetry/sdk-trace-node";
import type { SpanExporter } from "@opentelemetry/sdk-trace-node";
import { createProviderResource } from "./provider-resource.js";
import type { ProviderResourceInput } from "./provider-resource.js";
import type { ProviderOpsEnvelope } from "./event-envelope.js";

const INSTRUMENTATION_NAME = "@sdar/provider-ops-telemetry";
const INSTRUMENTATION_VERSION = "1.1.0";

export interface ProviderTelemetryBatchOptions {
  maxQueueSize?: number;
  maxExportBatchSize?: number;
  scheduledDelayMillis?: number;
  exportTimeoutMillis?: number;
}

export interface ProviderTelemetryOptions {
  resource: ProviderResourceInput;
  enabled?: boolean;
  otlpEndpoint?: string;
  metricExportIntervalMillis?: number;
  batch?: ProviderTelemetryBatchOptions;
  spanExporter?: SpanExporter;
  eventExporter?: LogRecordExporter;
  metricReader?: MetricReader;
}

export type ProviderMetricKind = "counter" | "histogram" | "gauge";

export interface AdapterRpcTelemetryContext {
  taskId?: string;
  externalExecutionId?: string;
  commandSequence?: number;
}

interface ProviderMetricInstrument {
  add?: (value: number, attributes?: Attributes) => void;
  record?: (value: number, attributes?: Attributes) => void;
  set?: (value: number, attributes?: Attributes) => void;
}

const BOUNDED_METRIC_LABELS = new Set([
  "commandType",
  "decision",
  "event",
  "method",
  "outcome",
  "reasonCode",
  "resultClass",
  "source",
  "state",
  "status",
]);

export class ProviderTelemetry {
  readonly #options: ProviderTelemetryOptions;
  #tracerProvider?: NodeTracerProvider;
  #loggerProvider?: LoggerProvider;
  #meterProvider?: MeterProvider;
  #started = false;
  #shutdown = false;
  readonly #metricInstruments = new Map<string, ProviderMetricInstrument>();

  constructor(options: ProviderTelemetryOptions) {
    this.#options = options;
  }

  start(): void {
    if (this.#started || this.#shutdown || this.#options.enabled !== true) return;
    const resource = createProviderResource(this.#options.resource);
    const spanExporter =
      this.#options.spanExporter ??
      new OTLPTraceExporter({ url: signalEndpoint(this.#options.otlpEndpoint, "traces") });
    const eventExporter =
      this.#options.eventExporter ??
      new OTLPLogExporter({ url: signalEndpoint(this.#options.otlpEndpoint, "logs") });
    const metricReader =
      this.#options.metricReader ??
      new PeriodicExportingMetricReader({
        exporter: new OTLPMetricExporter({
          url: signalEndpoint(this.#options.otlpEndpoint, "metrics"),
        }),
        exportIntervalMillis: this.#options.metricExportIntervalMillis ?? 60_000,
        exportTimeoutMillis: this.#options.batch?.exportTimeoutMillis ?? 10_000,
      });
    this.#tracerProvider = new NodeTracerProvider({
      resource,
      spanProcessors: [new BatchSpanProcessor(spanExporter, this.#options.batch)],
    });
    this.#loggerProvider = new LoggerProvider({
      resource,
      forceFlushTimeoutMillis: this.#options.batch?.exportTimeoutMillis ?? 10_000,
      processors: [
        new BatchLogRecordProcessor({ exporter: eventExporter, ...this.#options.batch }),
      ],
    });
    this.#meterProvider = new MeterProvider({ resource, readers: [metricReader] });
    this.#started = true;
  }

  async shutdown(): Promise<void> {
    if (this.#shutdown) return;
    this.#shutdown = true;
    const providers = [this.#tracerProvider, this.#loggerProvider, this.#meterProvider].filter(
      (provider) => provider !== undefined,
    );
    await Promise.allSettled(providers.map((provider) => provider.forceFlush()));
    await Promise.allSettled(providers.map((provider) => provider.shutdown()));
  }

  async trace<T>(name: string, attributes: Attributes, operation: () => Promise<T>): Promise<T> {
    if (!this.#started || this.#tracerProvider === undefined) return operation();
    const tracer = this.#tracerProvider.getTracer(INSTRUMENTATION_NAME, INSTRUMENTATION_VERSION);
    return tracer.startActiveSpan(name, { attributes }, async (span) => {
      try {
        const result = await operation();
        span.setStatus({ code: SpanStatusCode.OK });
        return result;
      } catch (error) {
        span.setStatus({ code: SpanStatusCode.ERROR });
        if (error instanceof Error) span.recordException(error);
        throw error;
      } finally {
        span.end();
      }
    });
  }

  adapterRpc(
    method: string,
    outcome: "success" | "error",
    durationMs: number,
    context: AdapterRpcTelemetryContext = {},
  ): void {
    if (!this.#started || this.#tracerProvider === undefined) return;
    try {
      const endTime = Date.now();
      const span = this.#tracerProvider
        .getTracer(INSTRUMENTATION_NAME, INSTRUMENTATION_VERSION)
        .startSpan("adapter.rpc", {
          attributes: {
            "adapter.provider": this.#options.resource.providerId,
            "rpc.system": "grpc",
            "rpc.method": method,
            ...(context.taskId === undefined || context.taskId.length === 0
              ? {}
              : { taskId: context.taskId }),
            ...(context.externalExecutionId === undefined ||
            context.externalExecutionId.length === 0
              ? {}
              : { externalExecutionId: context.externalExecutionId }),
            ...(context.commandSequence === undefined
              ? {}
              : { commandSequence: context.commandSequence }),
            duration: durationMs,
            status: outcome,
          },
          startTime: new Date(endTime - Math.max(0, durationMs)),
        });
      span.setStatus({
        code: outcome === "success" ? SpanStatusCode.OK : SpanStatusCode.ERROR,
      });
      span.end(endTime);
    } catch {
      // Instrumentation must never alter Adapter RPC behavior.
    }
  }

  event(name: string, body: unknown, attributes: Attributes = {}): void {
    if (!this.#started || this.#loggerProvider === undefined) return;
    this.#loggerProvider.getLogger(INSTRUMENTATION_NAME, INSTRUMENTATION_VERSION).emit({
      eventName: name,
      body: body as never,
      attributes,
      timestamp: new Date(),
    });
  }

  emitEnvelope(envelope: ProviderOpsEnvelope): void {
    this.event(envelope.recordType, envelope, {
      "sdar.schema.name": envelope.schemaName,
      "sdar.schema.version": envelope.schemaVersion,
      "sdar.record.id": envelope.recordId,
      "sdar.record.hash": envelope.recordHash,
    });
    const payload =
      typeof envelope.payload === "object" &&
      envelope.payload !== null &&
      !Array.isArray(envelope.payload)
        ? envelope.payload
        : {};
    if (envelope.recordType === "provider.task_lifecycle") {
      this.metric("provider_task_transition_total", 1, {
        state: stringAttribute(payload.currentState),
        resultClass: stringAttribute(payload.resultClass),
      });
    } else if (envelope.recordType === "provider.command_dispatch") {
      this.metric("provider_command_total", 1, {
        commandType: stringAttribute(payload.commandType),
        state: stringAttribute(payload.currentState),
        status: stringAttribute(payload.adapterRpcStatus),
      });
    }
  }

  metric(
    name: string,
    value = 1,
    attributes: Attributes = {},
    kind: ProviderMetricKind = "counter",
  ): void {
    if (!this.#started || this.#meterProvider === undefined) return;
    const key = `${kind}:${name}`;
    let instrument = this.#metricInstruments.get(key);
    if (instrument === undefined) {
      const meter = this.#meterProvider.getMeter(INSTRUMENTATION_NAME, INSTRUMENTATION_VERSION);
      if (kind === "counter") instrument = meter.createCounter(name);
      else if (kind === "histogram") instrument = meter.createHistogram(name);
      else {
        const gauge = meter.createObservableGauge(name);
        let currentValue = 0;
        let currentAttributes: Attributes = {};
        gauge.addCallback((observation) => observation.observe(currentValue, currentAttributes));
        instrument = {
          set: (nextValue, nextAttributes = {}) => {
            currentValue = nextValue;
            currentAttributes = nextAttributes;
          },
        };
      }
      this.#metricInstruments.set(key, instrument);
    }
    const boundedAttributes = boundedMetricAttributes(attributes);
    if (kind === "counter") instrument.add?.(value, boundedAttributes);
    else if (kind === "histogram") instrument.record?.(value, boundedAttributes);
    else instrument.set?.(value, boundedAttributes);
  }
}

function boundedMetricAttributes(attributes: Attributes): Attributes {
  return Object.fromEntries(
    Object.entries(attributes).filter(
      ([key, value]) => BOUNDED_METRIC_LABELS.has(key) && value !== undefined,
    ),
  );
}

function stringAttribute(value: unknown): string | undefined {
  return typeof value === "string" && value.length > 0 ? value : undefined;
}

function signalEndpoint(base: string | undefined, signal: "traces" | "metrics" | "logs"): string {
  const endpoint = (base ?? "http://127.0.0.1:4318").replace(/\/+$/, "");
  return `${endpoint}/v1/${signal}`;
}
