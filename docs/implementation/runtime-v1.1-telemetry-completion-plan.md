# Runtime v1.1 Telemetry Completion ExecPlan

Status: in progress

Base: `origin/main@43c0ced9caf560dab0d5a1427b10f385045d0847`

Branch: `fix/runtime-v1.1-telemetry-completion`

Target: `v1.1.0` (no `v1.1*` tag existed at H0 preflight)

## Scope and invariants

This plan closes the approved v1.1 Provider Telemetry Channel and durable Provider Ops delivery
gaps. It does not change MCP Task, command arbitration, scheduler, recovery or TTL business
semantics. Runtime remains independent of ClickHouse and SDAR Core. Collector failure is never a
readiness dependency and can never roll back a Task or command transaction.

Existing migrations are immutable. New persistence changes use migrations 017 and later. rc.2,
rc.3 and merged v1.1 evidence remain immutable. A real Collector/OTLP wire stack and historical
final-report repair are explicitly out of scope.

## Schema and compatibility strategy

- Provider Ops envelope schema version becomes `1.1.0`.
- Canonical record types use dotted names. A previous underscore name may appear only in
  `attributes.legacyRecordType`; records are never dual-emitted.
- `recordId` derives from stable business/event keys. `recordHash` excludes delivery metadata,
  including Runtime instance and emission time.
- A new Runtime-hosted `ProviderTelemetryIngress` service is added in a separate telemetry proto;
  the Adapter service direction remains unchanged. New fields use new field numbers and existing
  Adapter messages are not renumbered.
- Migration 017 adds durable Provider Ops delivery. Migration 018 adds persisted trace context.

## Ordered phases

| Phase | Deliverable                                               | Primary regression evidence         | Status      | Commit    |
| ----- | --------------------------------------------------------- | ----------------------------------- | ----------- | --------- |
| H0    | clean main baseline, red completion guards, this ExecPlan | baseline plus red suite             | complete    | `a01ae20` |
| H1    | canonical envelope, event names, stable identity/time     | envelope/legacy/replay tests        | complete    | `bc5da25` |
| H2    | durable audit capture and lease-safe publisher            | PostgreSQL retry/race tests         | complete    | `19c5442` |
| H3    | Runtime ProviderTelemetryIngress and validation           | provider ingress/conformance tests  | complete    | `3589e74` |
| H4    | real root/RPC trace propagation and persistence           | trace parent/restart tests          | complete    | `c3d8cbc` |
| H5    | complete Task and command transition audit coverage       | lifecycle matrix tests              | complete    | pending   |
| H6    | scheduler/recovery/TTL per-Task envelopes                 | component envelope tests            | in progress | pending   |
| H7    | sanitizer limits and trace failure isolation              | privacy/execute-once tests          | pending     | pending   |
| H8    | bounded metric values and drop/export/backlog accounting  | metric cardinality/failure tests    | pending     | pending   |
| H9    | secure production OTLP configuration                      | HTTPS/header/mTLS tests             | pending     | pending   |
| H10   | dual-language examples, docs, full gate, push and PR      | `pnpm verify:v1.1` and protected CI | pending     | pending   |

## Verification ledger

| Date       | Command                                              | Result                                                                           |
| ---------- | ---------------------------------------------------- | -------------------------------------------------------------------------------- |
| 2026-07-18 | tag preflight: `git tag --list "v1.1*"`              | PASS, no tag                                                                     |
| 2026-07-18 | `pnpm verify:v1.1` on clean merged main              | PASS, 375.2 seconds                                                              |
| 2026-07-18 | baseline test counts                                 | 49 unit, 4 contract, 164 integration, 9 recovery, 18 security, 4 E2E, 6 rc.2 red |
| 2026-07-18 | completion regression guard before implementation    | RED as expected, 7/7 failed                                                      |
| 2026-07-18 | H1 typecheck, lint and envelope/outbox focused tests | PASS, 18 tests                                                                   |
| 2026-07-18 | H2 PostgreSQL task lifecycle and delivery races      | PASS, 118 tests (110 lifecycle, 4 delivery, 4 upgrade/telemetry)                 |
| 2026-07-18 | H2 typecheck, lint and format check                  | PASS                                                                             |
| 2026-07-18 | H3 ingress, configuration and production security    | PASS, 30 tests                                                                   |
| 2026-07-18 | H3 gRPC wire, multi-replica idempotency and build    | PASS                                                                             |
| 2026-07-18 | H4 real spans, propagation, restart persistence      | PASS, 131 focused tests                                                          |
| 2026-07-18 | H4 migration 018 forward upgrade                     | PASS                                                                             |
| 2026-07-18 | H5 Task/command lifecycle PostgreSQL matrix          | PASS, 115 tests                                                                  |
| 2026-07-18 | H5 typecheck, lint and format check                  | PASS                                                                             |

This file is updated with real phase SHAs and verification results as work progresses. A phase is
complete only after its focused tests and static gates pass and its commit exists.
