# Runtime configuration reference

Configuration is read once from environment variables and validated before the service listens.
Invalid values fail startup; production never falls back from requested mTLS or JWT
authentication.

| Variable                           | Default                 | Meaning                                                    |
| ---------------------------------- | ----------------------- | ---------------------------------------------------------- |
| `HOST` / `PORT`                    | `0.0.0.0` / `8080`      | HTTP bind address and port                                 |
| `LOG_LEVEL`                        | `info`                  | Pino log level                                             |
| `RUNTIME_ENV`                      | `development`           | `development`, `test`, or fail-closed `production`         |
| `PROVIDER_ID`                      | `mock-provider`         | Must exactly match the Adapter Manifest                    |
| `DATABASE_URL`                     | local development URL   | PostgreSQL connection URI; use a production secret         |
| `DATABASE_POOL_MAX`                | `10`                    | Pool clients per Runtime replica, range 1-100              |
| `ADAPTER_ENDPOINT`                 | `127.0.0.1:7001`        | Fixed `host:port` gRPC endpoint                            |
| `ADAPTER_RPC_TIMEOUT_MS`           | `5000`                  | Per-RPC timeout, range 1-60,000 ms                         |
| `ADAPTER_TLS_MODE`                 | `disabled`              | `required` enables mutual TLS                              |
| `ADAPTER_TLS_CA_PATH`              | unset                   | PEM CA bundle for Adapter verification                     |
| `ADAPTER_TLS_CERT_PATH`            | unset                   | PEM Runtime client certificate                             |
| `ADAPTER_TLS_KEY_PATH`             | unset                   | PEM Runtime client private key                             |
| `AUTH_MODE`                        | `development`           | `development`, `trusted_headers`, or `jwt_hs256`           |
| `JWT_HS256_SECRET`                 | unset                   | At least 32 characters; required for `jwt_hs256`           |
| `JWT_ISSUER` / `JWT_AUDIENCE`      | unset                   | Optional exact JWT claim constraints                       |
| `HTTP_BODY_LIMIT_BYTES`            | `1048576`               | Fastify body limit, range 1 KiB-16 MiB                     |
| `ARGUMENT_MAX_BYTES`               | `1048576`               | Tool argument JSON byte limit                              |
| `ARGUMENT_MAX_DEPTH`               | `32`                    | Tool argument nesting limit, range 1-64                    |
| `ARGUMENT_MAX_NODES`               | `10000`                 | Tool argument node limit, range 16-100,000                 |
| `RATE_LIMIT_MAX`                   | `300`                   | Requests per source IP and window                          |
| `RATE_LIMIT_WINDOW_MS`             | `60000`                 | Rate window, range 1 second-1 hour                         |
| `RATE_LIMIT_MAX_KEYS`              | `10000`                 | Per-replica active source-key memory bound                 |
| `IDEMPOTENCY_LEASE_MS`             | `30000`                 | Durable invocation claim lease                             |
| `IDEMPOTENCY_WAIT_TIMEOUT_MS`      | `10000`                 | Duplicate PENDING wait bound                               |
| `IDEMPOTENCY_POLL_MS`              | `20`                    | Duplicate COMPLETE/PENDING poll delay                      |
| `ADAPTER_HEALTH_POLL_MS`           | `5000`                  | Continuous identity-checked Describe probe interval        |
| `ADAPTER_HEALTH_FAILURE_THRESHOLD` | `2`                     | Consecutive failed probes before Adapter becomes not-ready |
| `ADAPTER_MANIFEST_POLL_MS`         | `60000`                 | Startup Manifest hash drift check interval                 |
| `SCHEDULER_POLL_MS`                | `1000`                  | Durable due/deadline/watchdog worker interval              |
| `COMMAND_DISPATCH_CONCURRENCY`     | `8`                     | Per-replica command claims executed concurrently           |
| `SCHEDULER_CONCURRENCY`            | `8`                     | Per-replica scheduled-start claims executed concurrently   |
| `ALLOW_WEAK_LEASE_CONFIGURATION`   | `false`                 | Explicit boolean; forbidden in production                  |
| `RECOVERY_POLL_MS`                 | `5000`                  | Nonterminal Reconcile interval                             |
| `TTL_CLEANER_POLL_MS`              | `60000`                 | Logical-expiry and purge worker interval                   |
| `TTL_PURGE_GRACE_MS`               | `86400000`              | Expiry-to-purge delay, range 1 second-7 days               |
| `OUTBOX_PUBLISHED_RETENTION_MS`    | `86400000`              | Published outbox retention, range 60 seconds-90 days       |
| `TTL_CLEANER_BATCH_SIZE`           | `128`                   | Maximum rows claimed per cleaner stage and tick            |
| `OUTBOX_SINK`                      | `internal_noop`         | `internal_noop` or `webhook`                               |
| `OUTBOX_WEBHOOK_URL`               | unset                   | Required for webhook; HTTPS required in production         |
| `OUTBOX_POLL_MS`                   | `1000`                  | Publisher interval                                         |
| `OUTBOX_BATCH_SIZE`                | `100`                   | Maximum events per publication batch                       |
| `OUTBOX_WEBHOOK_TIMEOUT_MS`        | `5000`                  | Webhook request timeout                                    |
| `OTEL_ENABLED`                     | `false`                 | Enables best-effort OTLP traces, events, and metrics       |
| `OTEL_EXPORTER_OTLP_ENDPOINT`      | `http://127.0.0.1:4318` | OTLP/HTTP collector base URL                               |
| `OTEL_SERVICE_INSTANCE_ID`         | generated UUID          | Optional stable, replica-unique telemetry instance id      |

`development` authentication is limited to local Compose. `trusted_headers` requires an
authenticating proxy that strips client-supplied `x-sdar-subject` and `x-sdar-tenant` headers;
`jwt_hs256` is the standalone production mode. Rotate database, JWT and mTLS material through the
deployment platform, never ConfigMaps or command-line arguments.

Production startup requires non-development authentication, `ADAPTER_TLS_MODE=required` with
all three certificate paths, and `ALLOW_WEAK_LEASE_CONFIGURATION=false`. Boolean values accept
only `true`, `false`, `1`, or `0` (case-insensitive for words); ambiguous values fail startup.

The in-process rate limiter is bounded but applies per replica. Configure the ingress/API gateway
for a production-wide source or tenant limit. Keep `IDEMPOTENCY_LEASE_MS` greater than the
Adapter RPC timeout and within the upstream HTTP timeout budget. Claim/finalize and Task
publication use short database transactions; no checked-out PoolClient may span an Adapter RPC
or be re-borrowed after commit. Command and scheduler claims are limited to their configured
concurrency and renewed while an Adapter RPC is in flight.

Telemetry is not a readiness dependency. Production should use a stable, unique
`OTEL_SERVICE_INSTANCE_ID` per replica and route `OTEL_EXPORTER_OTLP_ENDPOINT` through the
deployment network policy. See [Provider Ops Telemetry](provider-ops-telemetry.md) for the event,
metric, privacy, and failure contracts.
