# Changelog

## 1.0.0-rc.1 - 2026-07-16

- Added independently deployable Node.js 22/TypeScript Runtime with MCP
  Streamable HTTP, health/readiness and Prometheus metrics.
- Added PostgreSQL authority, append-only migrations, immutable operation
  snapshots, durable SEP-2663/SDAR task lifecycle, scheduling, safe cancellation,
  input, pause/resume, monotonic observations and transactional Outbox.
- Added versioned gRPC/Protobuf Adapter protocol, recovery/Reconcile, durable
  idempotency and authorization/execution-mode isolation with mTLS/JWT options.
- Added TypeScript and Python reference Adapters and identical machine-readable
  P0-P4 conformance coverage.
- Added multi-stage non-root images, one-command Compose, Kubernetes manifests,
  upgrade/runbook/config/API/Adapter documentation, SBOM, dependency audit,
  security/recovery/E2E suites and capacity baseline.

This is a release candidate. Adapter protocol v1 and database migrations are
forward-additive; production rollout requires resource-specific conformance and
capacity testing.
