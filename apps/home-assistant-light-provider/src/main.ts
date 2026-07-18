import pino from "pino";
import { loadConfig } from "./config.js";
import { loadResourceConfig } from "./resources/resource-config.js";
import { LightResourceRegistry } from "./resources/registry.js";
import { HomeAssistantRestClient } from "./home-assistant/rest-client.js";
import { HomeAssistantWebSocketClient } from "./home-assistant/websocket-client.js";
import { JsonExecutionStore } from "./execution/execution-store.js";
import { DurableTelemetryQueue } from "./telemetry/durable-queue.js";
import { ProviderTelemetryClient } from "./telemetry/client.js";
import { LightExecutionEngine } from "./execution/execution-engine.js";
import { ConfirmationWorker } from "./execution/confirmation-worker.js";
import { normalizeLightState } from "./home-assistant/state-normalizer.js";
import { HomeAssistantLightProviderServer } from "./server.js";

const config = loadConfig(process.env);
const logger = pino({
  level: config.LOG_LEVEL,
  redact: {
    paths: ["homeAssistantToken", "token", "authorization", "*.token", "*.authorization"],
    censor: "[REDACTED]",
  },
});
const registry = new LightResourceRegistry(loadResourceConfig(config.LIGHT_RESOURCES_FILE));
const rest = new HomeAssistantRestClient({
  baseUrl: config.HOME_ASSISTANT_URL,
  token: config.homeAssistantToken,
  timeoutMs: config.HOME_ASSISTANT_REQUEST_TIMEOUT_MS,
});
const store = new JsonExecutionStore(config.PROVIDER_STATE_PATH);
const queue = new DurableTelemetryQueue(store);
const telemetry = new ProviderTelemetryClient(
  {
    providerId: config.PROVIDER_ID,
    endpoint: config.PROVIDER_TELEMETRY_ENDPOINT,
    enabled: config.PROVIDER_TELEMETRY_ENABLED,
    tlsMode: config.PROVIDER_TELEMETRY_TLS_MODE,
    ...(config.PROVIDER_TELEMETRY_TLS_CA_PATH === undefined
      ? {}
      : { caPath: config.PROVIDER_TELEMETRY_TLS_CA_PATH }),
    ...(config.PROVIDER_TELEMETRY_TLS_CERT_PATH === undefined
      ? {}
      : { certPath: config.PROVIDER_TELEMETRY_TLS_CERT_PATH }),
    ...(config.PROVIDER_TELEMETRY_TLS_KEY_PATH === undefined
      ? {}
      : { keyPath: config.PROVIDER_TELEMETRY_TLS_KEY_PATH }),
  },
  registry,
  queue,
);
const engine = new LightExecutionEngine(
  store,
  registry,
  rest,
  telemetry,
  config.HOME_ASSISTANT_CONFIRM_TIMEOUT_MS,
);
const websocket = new HomeAssistantWebSocketClient({
  baseUrl: config.HOME_ASSISTANT_URL,
  token: config.homeAssistantToken,
  entityIds: registry.entityIds(),
  reconnectMinMs: config.HOME_ASSISTANT_WS_RECONNECT_MIN_MS,
  reconnectMaxMs: config.HOME_ASSISTANT_WS_RECONNECT_MAX_MS,
});
websocket.onState((state) => {
  const resource = registry.fromEntity(state.entity_id);
  if (resource !== undefined) void engine.observe(normalizeLightState(resource.resourceId, state));
});
const worker = new ConfirmationWorker(store, engine, config.HOME_ASSISTANT_POLL_INTERVAL_MS);
const server = new HomeAssistantLightProviderServer(
  {
    providerId: config.PROVIDER_ID,
    providerVersion: config.PROVIDER_VERSION,
    host: config.ADAPTER_HOST,
    port: config.ADAPTER_PORT,
    tlsMode: config.ADAPTER_TLS_MODE,
    ...(config.ADAPTER_TLS_CA_PATH === undefined ? {} : { tlsCaPath: config.ADAPTER_TLS_CA_PATH }),
    ...(config.ADAPTER_TLS_CERT_PATH === undefined
      ? {}
      : { tlsCertPath: config.ADAPTER_TLS_CERT_PATH }),
    ...(config.ADAPTER_TLS_KEY_PATH === undefined
      ? {}
      : { tlsKeyPath: config.ADAPTER_TLS_KEY_PATH }),
  },
  registry,
  rest,
  store,
  engine,
);

await rest.checkApi();
await engine.recover();
telemetry.start();
websocket.start();
worker.start();
const port = await server.start();
logger.info({ providerId: config.PROVIDER_ID, port }, "Home Assistant light Provider started");
const shutdown = async (): Promise<void> => {
  worker.stop();
  websocket.stop();
  telemetry.stop();
  await server.close();
};
process.once("SIGINT", () => {
  void shutdown();
});
process.once("SIGTERM", () => {
  void shutdown();
});
