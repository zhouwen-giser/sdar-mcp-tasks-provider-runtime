# Home Assistant Climate Provider ExecPlan

Status: in progress

Base: `origin/main` at `d16cc55f3459148c86959db13427c26e45ace95f`

Target: `feature/home-assistant-climate-provider`

## Scope and invariants

Implement a standalone Node.js Provider at `apps/home-assistant-climate-provider` for explicitly
configured Home Assistant `climate.*` entities. It exposes synchronous state reads and durable
power, HVAC-mode, and target-temperature controls through the Runtime Adapter protocol.

Execution identity is persisted before Home Assistant side effects. `taskId` is idempotent,
reconcile is side-effect free, HTTP success is not terminal proof, completion requires observed
WebSocket or REST state, snapshot revisions are monotonic, terminal executions never regress,
and only configured resources may be controlled. Tokens come only from a secret file and are
forbidden from logs, errors, snapshots, results, and telemetry.

## First-version operations

- `climate_get_state` (`SYNCHRONOUS`)
- `climate_set_power` (`TASK_REQUIRED`)
- `climate_set_hvac_mode` (`TASK_REQUIRED`)
- `climate_set_temperature` (`TASK_REQUIRED`)

Fan mode, swing mode, humidity, presets, schedules owned by Home Assistant, discovery, direct
vendor protocols, pause/resume, and cancellation after dispatch are out of scope.

## Delivery phases

| Phase   | Deliverable                                         | Evidence                   | Status   |
| ------- | --------------------------------------------------- | -------------------------- | -------- |
| C0      | application, config, resource registry and manifest | unit tests                 | complete |
| C1      | REST/WebSocket client and climate normalization     | client/state tests         | complete |
| C2      | durable execution, confirmation and recovery        | integration/recovery tests | complete |
| C3      | durable Provider telemetry and security             | telemetry/security tests   | complete |
| C4      | Fake HA, Runtime E2E, image, Compose and docs       | E2E/deployment checks      | complete |
| Release | full repository verification and phased commits     | `pnpm verify:v1.1`         | pending  |

## Verification ledger

| Date       | Command                                     | Result |
| ---------- | ------------------------------------------- | ------ |
| 2026-07-18 | repository and protocol baseline inspection | PASS   |
| 2026-07-18 | TypeScript and ESLint                       | PASS   |
| 2026-07-18 | focused suite (4 files, 7 tests)            | PASS   |
| 2026-07-18 | Runtime/PostgreSQL climate E2E              | PASS   |
