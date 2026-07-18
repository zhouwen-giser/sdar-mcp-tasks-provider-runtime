# Home Assistant Light Provider ExecPlan

Status: frozen protocol migration complete; publication pending

Base: `origin/main` merged at `798656827ea747fb824df2975f8e66135e80fcc2`

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

| Phase   | Deliverable                                               | Required evidence                       | Status   |
| ------- | --------------------------------------------------------- | --------------------------------------- | -------- |
| H0      | application/config/resource scaffold and manifest         | config, registry, manifest tests        | complete |
| H1      | REST/WebSocket client and state normalization             | client, conversion, reconnect tests     | complete |
| H2      | durable execution, confirmation, recovery and Adapter RPC | idempotency/reconcile/restart tests     | complete |
| H3      | durable resource and execution telemetry                  | stable ID/queue/failure-isolation tests | complete |
| H4      | security hardening and deployment assets                  | security tests and image/compose checks | complete |
| H5      | integration, Runtime E2E and documentation                | HA-provider tests and Runtime workflow  | complete |
| H6      | frozen Wire, type-only Evidence, notification E2E, report | Provider V1 conformance gate            | complete |
| Release | full verification, phased commits, push and Draft PR      | clean SHA and protected CI              | complete |

## Verification ledger

| Date       | Command                                     | Result |
| ---------- | ------------------------------------------- | ------ |
| 2026-07-18 | repository and protocol baseline inspection | PASS   |
| 2026-07-18 | `pnpm test:ha-light` (4 files, 9 tests)     | PASS   |
| 2026-07-18 | `pnpm test:ha-light:e2e` with PostgreSQL    | PASS   |
| 2026-07-18 | `pnpm audit:dependencies`                   | PASS   |
| 2026-07-18 | `pnpm verify:v1.1` (380.5 seconds)          | PASS   |
| 2026-07-18 | Draft PR #12 `runtime-compose` (56 seconds) | PASS   |
| 2026-07-18 | Draft PR #12 `runtime-ci` (4m 11s)          | PASS   |
| 2026-07-19 | merge protected Runtime main                | PASS   |
| 2026-07-19 | `pnpm test:ha-light:protocol-v1` (10 tests) | PASS   |
| 2026-07-19 | `pnpm protocol:ha-light:check` (8/8)        | PASS   |
| 2026-07-19 | exact `004d3d6` `pnpm verify:v2` (500.8s)   | PASS   |

This plan is updated as implementation and evidence evolve. A phase is complete only after its
tests pass and its commit is created.
