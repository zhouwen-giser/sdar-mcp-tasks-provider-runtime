import { z } from "zod";

const EnvironmentSchema = z
  .object({
    HOST: z.string().default("0.0.0.0"),
    PORT: z.coerce.number().int().min(1).max(65_535).default(8080),
    LOG_LEVEL: z.string().default("info"),
    PROVIDER_ID: z.string().min(1).max(128).default("mock-provider"),
    DATABASE_URL: z.url().default("postgresql://sdar:sdar@127.0.0.1:5432/sdar_runtime"),
    ADAPTER_ENDPOINT: z.string().refine(validAdapterEndpoint).default("127.0.0.1:7001"),
    ADAPTER_TLS_MODE: z.enum(["disabled", "required"]).default("disabled"),
    ADAPTER_TLS_CA_PATH: z.string().min(1).optional(),
    ADAPTER_TLS_CERT_PATH: z.string().min(1).optional(),
    ADAPTER_TLS_KEY_PATH: z.string().min(1).optional(),
    ADAPTER_RPC_TIMEOUT_MS: z.coerce.number().int().positive().max(60_000).default(5_000),
    AUTH_MODE: z.enum(["development", "trusted_headers", "jwt_hs256"]).default("development"),
    JWT_HS256_SECRET: z.string().min(32).optional(),
    JWT_ISSUER: z.string().min(1).optional(),
    JWT_AUDIENCE: z.string().min(1).optional(),
    HTTP_BODY_LIMIT_BYTES: z.coerce.number().int().min(1_024).max(16_777_216).default(1_048_576),
    ARGUMENT_MAX_BYTES: z.coerce.number().int().min(256).max(8_388_608).default(1_048_576),
    ARGUMENT_MAX_DEPTH: z.coerce.number().int().min(1).max(64).default(32),
    ARGUMENT_MAX_NODES: z.coerce.number().int().min(16).max(100_000).default(10_000),
    RATE_LIMIT_MAX: z.coerce.number().int().min(1).max(100_000).default(300),
    RATE_LIMIT_WINDOW_MS: z.coerce.number().int().min(1_000).max(3_600_000).default(60_000),
    RATE_LIMIT_MAX_KEYS: z.coerce.number().int().min(16).max(1_000_000).default(10_000),
    DATABASE_POOL_MAX: z.coerce.number().int().min(1).max(100).default(10),
    IDEMPOTENCY_LEASE_MS: z.coerce.number().int().min(1_000).max(300_000).default(30_000),
    IDEMPOTENCY_WAIT_TIMEOUT_MS: z.coerce.number().int().min(100).max(60_000).default(10_000),
    IDEMPOTENCY_POLL_MS: z.coerce.number().int().min(5).max(1_000).default(20),
    ADAPTER_HEALTH_POLL_MS: z.coerce.number().int().min(100).max(300_000).default(5_000),
    ADAPTER_HEALTH_FAILURE_THRESHOLD: z.coerce.number().int().min(1).max(10).default(2),
    SCHEDULER_POLL_MS: z.coerce.number().int().min(100).max(60_000).default(1_000),
    RECOVERY_POLL_MS: z.coerce.number().int().min(500).max(300_000).default(5_000),
    TTL_CLEANER_POLL_MS: z.coerce.number().int().min(500).max(3_600_000).default(60_000),
    TTL_PURGE_GRACE_MS: z.coerce.number().int().min(1_000).max(604_800_000).default(86_400_000),
    TTL_CLEANER_BATCH_SIZE: z.coerce.number().int().min(1).max(10_000).default(128),
  })
  .superRefine((value, context) => {
    if (
      value.ADAPTER_TLS_MODE === "required" &&
      (value.ADAPTER_TLS_CA_PATH === undefined ||
        value.ADAPTER_TLS_CERT_PATH === undefined ||
        value.ADAPTER_TLS_KEY_PATH === undefined)
    ) {
      context.addIssue({ code: "custom", message: "mTLS requires CA, certificate, and key paths" });
    }
    if (value.AUTH_MODE === "jwt_hs256" && value.JWT_HS256_SECRET === undefined) {
      context.addIssue({ code: "custom", message: "jwt_hs256 requires JWT_HS256_SECRET" });
    }
  });

export type RuntimeConfig = z.infer<typeof EnvironmentSchema>;

export function loadRuntimeConfig(environment: NodeJS.ProcessEnv = process.env): RuntimeConfig {
  return EnvironmentSchema.parse(environment);
}

function validAdapterEndpoint(value: string): boolean {
  if (!/^(?:[A-Za-z0-9.-]+|\[[0-9A-Fa-f:]+\]):\d{1,5}$/.test(value)) return false;
  const port = Number(value.slice(value.lastIndexOf(":") + 1));
  return Number.isInteger(port) && port >= 1 && port <= 65_535;
}
