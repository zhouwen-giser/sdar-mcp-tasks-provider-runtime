# Runtime configuration reference

Configuration is read once from environment variables and validated before the
service listens. Invalid values fail startup; production does not fall back from
requested mTLS or JWT authentication.

| Variable                           | Default               | Meaning                                               |
| ---------------------------------- | --------------------- | ----------------------------------------------------- |
| `HOST` / `PORT`                    | `0.0.0.0` / `8080`    | HTTP bind address and port                            |
| `LOG_LEVEL`                        | `info`                | Pino log level                                        |
| `PROVIDER_ID`                      | `mock-provider`       | Must exactly match Adapter Manifest                   |
| `DATABASE_URL`                     | local development URL | PostgreSQL connection URI; required production secret |
| `ADAPTER_ENDPOINT`                 | `127.0.0.1:7001`      | Fixed `host:port` gRPC endpoint                       |
| `ADAPTER_RPC_TIMEOUT_MS`           | `5000`                | Per-RPC timeout, 1–60000 ms                           |
| `ADAPTER_TLS_MODE`                 | `disabled`            | `required` enables mutual TLS                         |
| `ADAPTER_TLS_CA_PATH`              | unset                 | PEM CA bundle for Adapter verification                |
| `ADAPTER_TLS_CERT_PATH`            | unset                 | PEM Runtime client certificate                        |
| `ADAPTER_TLS_KEY_PATH`             | unset                 | PEM Runtime client private key                        |
| `AUTH_MODE`                        | `development`         | `development`, `trusted_headers`, or `jwt_hs256`      |
| `JWT_HS256_SECRET`                 | unset                 | At least 32 characters; required for `jwt_hs256`      |
| `JWT_ISSUER` / `JWT_AUDIENCE`      | unset                 | Optional exact JWT claim constraints                  |
| `HTTP_BODY_LIMIT_BYTES`            | `1048576`             | Fastify request body limit, 1 KiB–16 MiB              |
| `ARGUMENT_MAX_BYTES`               | `1048576`             | Tool argument JSON byte limit                         |
| `ARGUMENT_MAX_DEPTH`               | `32`                  | Tool argument nesting limit, 1–64                     |
| `ARGUMENT_MAX_NODES`               | `10000`               | Tool argument node limit, 16–100000                   |
| `RATE_LIMIT_MAX`                   | `300`                 | Requests per source IP and window                     |
| `RATE_LIMIT_WINDOW_MS`             | `60000`               | Rate window, 1 second–1 hour                          |
| `RATE_LIMIT_MAX_KEYS`              | `10000`               | Per-replica active source-key memory bound            |
| `DATABASE_POOL_MAX`                | `10`                  | PostgreSQL Pool clients per Runtime replica           |
| `IDEMPOTENCY_LEASE_MS`             | `30000`               | Durable invocation claim lease                        |
| `IDEMPOTENCY_WAIT_TIMEOUT_MS`      | `10000`               | Duplicate PENDING wait bound                          |
| `IDEMPOTENCY_POLL_MS`              | `20`                  | Duplicate COMPLETE/PENDING poll delay                 |
| `ADAPTER_HEALTH_POLL_MS`           | `5000`                | Continuous Adapter Describe probe interval            |
| `ADAPTER_HEALTH_FAILURE_THRESHOLD` | `2`                   | Consecutive failed probes before not-ready            |
| `SCHEDULER_POLL_MS`                | `1000`                | Durable due/deadline worker interval                  |
| `RECOVERY_POLL_MS`                 | `5000`                | Nonterminal reconcile interval                        |
| `TTL_CLEANER_POLL_MS`              | `60000`               | Logical-expiry and purge worker interval              |
| `TTL_PURGE_GRACE_MS`               | `86400000`            | Expiry-to-purge delay, 1 second–7 days                |
| `TTL_CLEANER_BATCH_SIZE`           | `128`                 | Maximum rows claimed per cleaner stage and tick       |

`development` authentication is limited to local Compose. `trusted_headers`
requires an authenticating proxy that strips client-supplied
`x-sdar-subject`/`x-sdar-tenant`; `jwt_hs256` is the standalone production mode
in V1.0. Rotate database, JWT and mTLS material through the deployment platform,
never ConfigMaps or command-line arguments.

The in-process rate limiter is deliberately bounded but applies per replica. Configure the
ingress/API gateway for a production-wide source or tenant limit. Idempotency lease and wait
values must remain below the upstream HTTP timeout budget; increasing them does not change the
stable Task identity or permit a database connection to span the Adapter RPC.
