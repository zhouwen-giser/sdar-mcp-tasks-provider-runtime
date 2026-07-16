import { z } from "zod";

const EnvironmentSchema = z.object({
  HOST: z.string().default("0.0.0.0"),
  PORT: z.coerce.number().int().min(1).max(65_535).default(8080),
  LOG_LEVEL: z.string().default("info"),
  PROVIDER_ID: z.string().min(1).max(128).default("mock-provider"),
  DATABASE_URL: z.url().default("postgresql://sdar:sdar@127.0.0.1:5432/sdar_runtime"),
  ADAPTER_ENDPOINT: z.string().min(1).default("127.0.0.1:7001"),
  ADAPTER_TLS_MODE: z.enum(["disabled", "required"]).default("disabled"),
  ADAPTER_RPC_TIMEOUT_MS: z.coerce.number().int().positive().max(60_000).default(5_000),
  SCHEDULER_POLL_MS: z.coerce.number().int().min(100).max(60_000).default(1_000),
});

export type RuntimeConfig = z.infer<typeof EnvironmentSchema>;

export function loadRuntimeConfig(environment: NodeJS.ProcessEnv = process.env): RuntimeConfig {
  return EnvironmentSchema.parse(environment);
}
