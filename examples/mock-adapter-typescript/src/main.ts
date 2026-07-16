import { createLogger } from "../../../packages/observability/src/index.js";
import { bindMockAdapter, createMockAdapterServer } from "./server.js";

const logger = createLogger(process.env.LOG_LEVEL ?? "info");
const host = process.env.ADAPTER_HOST ?? "0.0.0.0";
const port = Number(process.env.ADAPTER_PORT ?? "7001");
const server = createMockAdapterServer({ providerId: process.env.PROVIDER_ID ?? "mock-provider" });

try {
  const boundPort = await bindMockAdapter(server, `${host}:${String(port)}`);
  logger.info({ host, port: boundPort }, "TypeScript mock Adapter listening");
} catch (error) {
  logger.fatal({ err: error }, "TypeScript mock Adapter failed to start");
  process.exitCode = 1;
}

async function shutdown(signal: string): Promise<void> {
  logger.info({ signal }, "TypeScript mock Adapter shutting down");
  await new Promise<void>((resolve) => server.tryShutdown(() => resolve()));
}

process.once("SIGINT", () => void shutdown("SIGINT"));
process.once("SIGTERM", () => void shutdown("SIGTERM"));
