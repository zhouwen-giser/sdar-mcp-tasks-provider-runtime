# Runtime V1.0 Requirement Traceability

This is the maintained implementation matrix. Status values are `planned`,
`implemented`, and `verified`; a row becomes verified only when its named gate
has produced real evidence.

| Requirement | Authority | Phase(s) | Implementation paths | Verification paths / gates | Status |
|---|---|---|---|---|---|
| RQ-MCP | Profile 5-8, 21-24, 33 | R2, R3, R6 | `packages/mcp-protocol`, `apps/runtime` | `tests/contract/mcp`, `tests/e2e`; `test:contract`, `test:e2e` | planned |
| RQ-REG | Runtime 4; Adapter 5 | R2 | `packages/operation-registry`, `packages/persistence-postgres` | registry unit/security and snapshot integration tests | planned |
| RQ-ADAPTER | Adapter 4-15 | R1-R8 | `proto/io/sdar/mcp/tasks/adapter/v1`, `packages/adapter-protocol` | Proto contract and dual-language conformance | planned |
| RQ-STATE | Profile 5, 17, 24; Runtime 5 | R3, R6 | `packages/domain`, `packages/task-engine` | transition-table/property and Snapshot mapping tests | planned |
| RQ-ADMISSION | Runtime 6, 8, 10 | R3, R4, R7 | `packages/task-engine`, `packages/persistence-postgres` | crash-window, response-loss and recovery integration tests | planned |
| RQ-AVAIL | Profile 8-11 | R4 | `packages/task-engine`, `packages/mcp-protocol` | four-state/window/timeout contract and E2E tests | planned |
| RQ-TIME | Profile 12-15 | R5 | `packages/domain`, `packages/task-engine`, scheduler repositories | fake-clock timing matrix, restart and multi-claim tests | planned |
| RQ-CANCEL | Profile 23, 36; Adapter 12 | R6, R7 | task control service and Adapter gateway | Ack/STOPPING/safe-stop/natural-race/deadline tests | planned |
| RQ-INPUT | Profile 22; Adapter 11 | R6 | input repository and task control service | stable-key, partial, duplicate and unknown-key tests | planned |
| RQ-IDEMP | Profile 29; Adapter 8, 15 | R3-R5 | idempotency/admission repositories and canonical hashing | duplicate/conflict/concurrent/restart suites | planned |
| RQ-OBS | Profile 17-18, 32 | R6 | observation/outbox repositories and publisher | revision duplicate/jump/order and delivery tests | planned |
| RQ-RECOVERY | Profile 30; Runtime 10 | R3, R4, R5, R7 | recovery manager and Adapter reconcile gateway | Runtime/Adapter/DB/reconcile fault suites | planned |
| RQ-PERSIST | Runtime 8; task package RQ-PERSIST | R2-R7 | `migrations`, `packages/persistence-postgres` | empty/upgrade migration and real PostgreSQL tests | planned |
| RQ-SEC | Profile 20, 34-35; Adapter 16 | R2, R7 | auth, execution context, limits, mTLS, redaction | JWT/trusted identity, cross-context, injection and log tests | planned |
| RQ-OBSERVABILITY | Runtime 12 | R1, R7, R9 | `packages/observability`, Runtime health/metrics | health/readiness, metrics, trace and redaction tests | planned |
| RQ-CONFORMANCE | Profile 37-39; Adapter 19-21 | R8, R9 | `packages/conformance-testkit`, both example Adapters | P0-P4 JSON reports and identical dual-language E2E | planned |
| Deployment/operations | Task package R1, R9 | R1, R9 | `Dockerfile`, Compose, `deploy`, operations docs | image build, Compose health, manifest rendering | planned |
| Release integrity | Task package DoD | R9 | root scripts, CI, changelog, reports, SBOM | `pnpm verify`, audit/SBOM, phase SHA/push evidence | planned |

## Mandatory scenario ownership

| Scenario family | Primary phase | Required evidence |
|---|---|---|
| Capability negotiation, Tool count and execution modes | R2 | MCP contract/E2E |
| Accepted/rejected creation and crash windows | R3-R4 | PostgreSQL + gRPC integration/recovery |
| Standard/substates, business/technical terminals | R3, R6 | domain and E2E state matrices |
| Immediate/scheduled/deadline timing | R5 | deterministic Clock + database claim tests |
| Cancel/update/pause/resume | R6 | control race and Adapter contract tests |
| Runtime/Adapter/database/event/outbox faults | R7 | recovery/fault suite |
| Authorization, mode, limits, redaction and mTLS | R7 | security suite |
| TypeScript/Python parity | R8 | machine-readable P0-P4 reports |
| Container/deployment/upgrade/audit/capacity | R9 | release verification report |

## R0 evidence

- Specifications and the real repository were read in full.
- No AGENTS/PLANS/CI/code/migration/test assets existed to inherit.
- Empty-project `pnpm test` and `pnpm build` failures are recorded in the
  repository assessment.
- All task-package RQ groups and Definition-of-Done delivery areas now have an
  implementation phase, concrete path, and verification gate.
