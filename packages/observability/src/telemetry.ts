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

export type ProviderMetricKind = "counter" | "histogram";

interface ProviderMetricInstrument {
  add?: (value: number, attributes?: Attributes) => void;
  record?: (value: number, attributes?: Attributes) => void;
}

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
      instrument = kind === "counter" ? meter.createCounter(name) : meter.createHistogram(name);
      this.#metricInstruments.set(key, instrument);
    }
    if (kind === "counter") instrument.add?.(value, attributes);
    else instrument.record?.(value, attributes);
  }
}

function signalEndpoint(base: string | undefined, signal: "traces" | "metrics" | "logs"): string {
  const endpoint = (base ?? "http://127.0.0.1:4318").replace(/\/+$/, "");
  return `${endpoint}/v1/${signal}`;
}
