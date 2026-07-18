# Home Assistant Light Provider ExecPlan

Status: complete

Base: `origin/main`

Target: `feature/home-assistant-light-provider`

## Scope and invariants

Implement a standalone Node.js Provider at `apps/home-assistant-light-provider` for explicitly
configured Home Assistant `light.*` entities. It exposes `light_get_state`, `light_set_power`, and
`light_set_brightness` through the Runtime Adapter protocol and emits resource and execution
telemetry through `ProviderTelemetryIngress`.

The Provider persists execution identity before a Home Assistant side effect, treats `taskId` as
the idempotency key, keeps reconciliation side-effect free, confirms control through observed
state rather than an HTTP success response, increments snapshot revisions monotonically, and
never regresses terminal executions. Home Assistant credentials come only from a secret file and
must not enter logs, snapshots, errors, results, or telemetry.

## Delivery phases

| Phase   | Deliverable                                               | Required evidence                       | Status      |
| ------- | --------------------------------------------------------- | --------------------------------------- | ----------- |
| H0      | application/config/resource scaffold and manifest         | config, registry, manifest tests        | complete    |
| H1      | REST/WebSocket client and state normalization             | client, conversion, reconnect tests     | complete    |
| H2      | durable execution, confirmation, recovery and Adapter RPC | idempotency/reconcile/restart tests     | complete    |
| H3      | durable resource and execution telemetry                  | stable ID/queue/failure-isolation tests | complete    |
| H4      | security hardening and deployment assets                  | security tests and image/compose checks | complete    |
| H5      | integration, Runtime E2E and documentation                | HA-provider tests and Runtime workflow  | complete    |
| Release | full verification, phased commits, push and Draft PR      | clean SHA and protected CI              | in progress |

## Verification ledger

| Date       | Command                                     | Result |
| ---------- | ------------------------------------------- | ------ |
| 2026-07-18 | repository and protocol baseline inspection | PASS   |
| 2026-07-18 | `pnpm test:ha-light` (4 files, 9 tests)     | PASS   |
| 2026-07-18 | `pnpm test:ha-light:e2e` with PostgreSQL    | PASS   |
| 2026-07-18 | `pnpm audit:dependencies`                   | PASS   |
| 2026-07-18 | `pnpm verify:v1.1` (380.5 seconds)          | PASS   |

This plan is updated as implementation and evidence evolve. A phase is complete only after its
tests pass and its commit is created.
