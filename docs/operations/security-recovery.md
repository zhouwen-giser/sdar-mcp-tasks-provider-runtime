# Security, Recovery, and Telemetry

Runtime has three inbound authentication modes:

- `development` supplies a fixed anonymous identity and is intended only for local Compose;
- `trusted_headers` requires `x-sdar-subject` and `x-sdar-tenant` from an authenticated trusted proxy;
- `jwt_hs256` requires a secret of at least 32 characters and validates HS256, `exp`, optional `nbf`, configured issuer/audience, `sub`, and `tenant`.

Clients may select `live`, `simulation`, or `historical-replay`, but non-live requests must include a simulation id. Task ownership is the SHA-256 binding of tenant and subject plus the exact execution mode/simulation identity. Cross-context get, update, and cancel return not-found.

Set `ADAPTER_TLS_MODE=required` with `ADAPTER_TLS_CA_PATH`, `ADAPTER_TLS_CERT_PATH`, and `ADAPTER_TLS_KEY_PATH` for Runtime-to-Adapter mutual TLS. `disabled` is explicit plaintext development transport. Secret file contents and bearer tokens are redacted and are never included in task trace events.

Startup readiness requires database migrations, Adapter Manifest/connectivity checks, snapshot persistence, and an initial recovery scan. Recovery uses a transaction-scoped advisory lock per taskId. It reconciles every nonterminal external execution, replays PENDING controls by original command sequence, and safely retries admission by the original taskId only after a NOT_FOUND proof. Periodic scans provide polling fallback. TRANSIENT_UNAVAILABLE retains the last durable fact; confirmed missing bound execution becomes a visible technical failure.

`/metrics` exports Prometheus text for task states, Tool call count/latency, cancel requests, Adapter RPC outcomes, recovery scans, idempotency hits, rate limiting, and pending Outbox events. Structured trace events contain providerId, taskId, operationName, resourceRef, executionMode, and correlationId without full arguments.
