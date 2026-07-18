import { readFileSync } from "node:fs";
import { z } from "zod";

const booleanValue = z
  .enum(["true", "false", "1", "0"])
  .transform((value) => value === "true" || value === "1");
const optionalPath = z
  .string()
  .transform((value) => value.trim() || undefined)
  .optional();
const tlsMode = z.enum(["disabled", "required"]);

const environmentSchema = z.object({
  PROVIDER_ID: z.string().min(1).default("home-assistant-light"),
  PROVIDER_VERSION: z.string().min(1).default("0.1.0"),
  ADAPTER_HOST: z.string().min(1).default("0.0.0.0"),
  ADAPTER_PORT: z.coerce.number().int().min(1).max(65_535).default(7010),
  ADAPTER_TLS_MODE: tlsMode.default("disabled"),
  ADAPTER_TLS_CA_PATH: optionalPath,
  ADAPTER_TLS_CERT_PATH: optionalPath,
  ADAPTER_TLS_KEY_PATH: optionalPath,
  HOME_ASSISTANT_URL: z.url(),
  HOME_ASSISTANT_TOKEN_FILE: z.string().min(1),
  HOME_ASSISTANT_ALLOW_INSECURE_HTTP: booleanValue.default(false),
  HOME_ASSISTANT_REQUEST_TIMEOUT_MS: z.coerce.number().int().positive().default(5000),
  HOME_ASSISTANT_CONFIRM_TIMEOUT_MS: z.coerce.number().int().positive().default(10_000),
  HOME_ASSISTANT_POLL_INTERVAL_MS: z.coerce.number().int().positive().default(500),
  HOME_ASSISTANT_WS_RECONNECT_MIN_MS: z.coerce.number().int().positive().default(500),
  HOME_ASSISTANT_WS_RECONNECT_MAX_MS: z.coerce.number().int().positive().default(30_000),
  LIGHT_RESOURCES_FILE: z.string().min(1),
  PROVIDER_STATE_PATH: z.string().min(1),
  PROVIDER_TELEMETRY_ENABLED: booleanValue.default(true),
  PROVIDER_TELEMETRY_ENDPOINT: z.string().min(1).default("127.0.0.1:7002"),
  PROVIDER_TELEMETRY_TLS_MODE: tlsMode.default("disabled"),
  PROVIDER_TELEMETRY_TLS_CA_PATH: optionalPath,
  PROVIDER_TELEMETRY_TLS_CERT_PATH: optionalPath,
  PROVIDER_TELEMETRY_TLS_KEY_PATH: optionalPath,
  LOG_LEVEL: z.enum(["trace", "debug", "info", "warn", "error", "fatal"]).default("info"),
  RUNTIME_ENV: z.enum(["development", "test", "production"]).default("development"),
});

export type ProviderConfig = z.infer<typeof environmentSchema> & { homeAssistantToken: string };

export function loadConfig(environment: NodeJS.ProcessEnv): ProviderConfig {
  if (Object.hasOwn(environment, "HOME_ASSISTANT_TOKEN")) {
    throw new Error("HOME_ASSISTANT_TOKEN_ENVIRONMENT_FORBIDDEN");
  }
  const parsed = environmentSchema.parse(environment);
  validateTls(
    parsed.ADAPTER_TLS_MODE,
    parsed.ADAPTER_TLS_CA_PATH,
    parsed.ADAPTER_TLS_CERT_PATH,
    parsed.ADAPTER_TLS_KEY_PATH,
    "ADAPTER",
  );
  if (parsed.PROVIDER_TELEMETRY_ENABLED) {
    validateTls(
      parsed.PROVIDER_TELEMETRY_TLS_MODE,
      parsed.PROVIDER_TELEMETRY_TLS_CA_PATH,
      parsed.PROVIDER_TELEMETRY_TLS_CERT_PATH,
      parsed.PROVIDER_TELEMETRY_TLS_KEY_PATH,
      "PROVIDER_TELEMETRY",
    );
  }
  const url = new URL(parsed.HOME_ASSISTANT_URL);
  if (
    parsed.RUNTIME_ENV === "production" &&
    url.protocol === "http:" &&
    !parsed.HOME_ASSISTANT_ALLOW_INSECURE_HTTP
  ) {
    throw new Error("HOME_ASSISTANT_INSECURE_HTTP_FORBIDDEN");
  }
  if (url.protocol !== "http:" && url.protocol !== "https:")
    throw new Error("HOME_ASSISTANT_URL_PROTOCOL_INVALID");
  const homeAssistantToken = readFileSync(parsed.HOME_ASSISTANT_TOKEN_FILE, "utf8").trim();
  if (homeAssistantToken.length === 0) throw new Error("HOME_ASSISTANT_TOKEN_FILE_EMPTY");
  return { ...parsed, homeAssistantToken };
}

function validateTls(
  mode: "disabled" | "required",
  ca: string | undefined,
  cert: string | undefined,
  key: string | undefined,
  prefix: string,
): void {
  if (mode === "required" && (ca === undefined || cert === undefined || key === undefined)) {
    throw new Error(`${prefix}_MTLS_FILES_REQUIRED`);
  }
}
