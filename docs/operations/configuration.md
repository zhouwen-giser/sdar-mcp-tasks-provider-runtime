# Runtime configuration reference

Configuration is read once from environment variables and validated before the
service listens. Invalid values fail startup; production does not fall back from
requested mTLS or JWT authentication.

| Variable                      | Default               | Meaning                                               |
| ----------------------------- | --------------------- | ----------------------------------------------------- |
| `HOST` / `PORT`               | `0.0.0.0` / `8080`    | HTTP bind address and port                            |
| `LOG_LEVEL`                   | `info`                | Pino log level                                        |
| `PROVIDER_ID`                 | `mock-provider`       | Must exactly match Adapter Manifest                   |
| `DATABASE_URL`                | local development URL | PostgreSQL connection URI; required production secret |
| `ADAPTER_ENDPOINT`            | `127.0.0.1:7001`      | Fixed `host:port` gRPC endpoint                       |
| `ADAPTER_RPC_TIMEOUT_MS`      | `5000`                | Per-RPC timeout, 1–60000 ms                           |
| `ADAPTER_TLS_MODE`            | `disabled`            | `required` enables mutual TLS                         |
| `ADAPTER_TLS_CA_PATH`         | unset                 | PEM CA bundle for Adapter verification                |
| `ADAPTER_TLS_CERT_PATH`       | unset                 | PEM Runtime client certificate                        |
| `ADAPTER_TLS_KEY_PATH`        | unset                 | PEM Runtime client private key                        |
| `AUTH_MODE`                   | `development`         | `development`, `trusted_headers`, or `jwt_hs256`      |
| `JWT_HS256_SECRET`            | unset                 | At least 32 characters; required for `jwt_hs256`      |
| `JWT_ISSUER` / `JWT_AUDIENCE` | unset                 | Optional exact JWT claim constraints                  |
| `HTTP_BODY_LIMIT_BYTES`       | `1048576`             | Fastify request body limit, 1 KiB–16 MiB              |
| `ARGUMENT_MAX_BYTES`          | `1048576`             | Tool argument JSON byte limit                         |
| `ARGUMENT_MAX_DEPTH`          | `32`                  | Tool argument nesting limit, 1–64                     |
| `ARGUMENT_MAX_NODES`          | `10000`               | Tool argument node limit, 16–100000                   |
| `RATE_LIMIT_MAX`              | `300`                 | Requests per source IP and window                     |
| `RATE_LIMIT_WINDOW_MS`        | `60000`               | Rate window, 1 second–1 hour                          |
| `SCHEDULER_POLL_MS`           | `1000`                | Durable due/deadline worker interval                  |
| `RECOVERY_POLL_MS`            | `5000`                | Nonterminal reconcile interval                        |

`development` authentication is limited to local Compose. `trusted_headers`
requires an authenticating proxy that strips client-supplied
`x-sdar-subject`/`x-sdar-tenant`; `jwt_hs256` is the standalone production mode
in V1.0. Rotate database, JWT and mTLS material through the deployment platform,
never ConfigMaps or command-line arguments.
