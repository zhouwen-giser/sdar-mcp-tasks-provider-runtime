# Changed Files

This ledger is maintained from the execution-time base `c5594e4cb59f77421a8aa107defa6054ca61a768`.

## Baseline and planning

- `docs/implementation/runtime-conformance-closure-exec-plan.md`
- `reports/runtime-conformance-closure/baseline.json`
- `reports/runtime-conformance-closure/failing-cases.md`
- `reports/runtime-conformance-closure/changed-files.md`
- `reports/runtime-conformance-closure/upstream-merges.md`

## H0 red tests

- `package.json` (closure-only test scripts; existing Provider scripts retained)
- `tests/runtime-conformance-closure/mrtr-inbox.test.ts`
- `packages/task-engine/src/command-dispatcher.ts`
- `tests/runtime-conformance-closure/mrtr-recovery.test.ts`
- `tests/runtime-conformance-closure/error-mapping.test.ts`
- `tests/runtime-conformance-closure/notification-identity.test.ts`
- `tests/runtime-conformance-closure/notification-capacity.test.ts`
- `tests/runtime-conformance-closure/notification-batch.test.ts`
- `tests/runtime-conformance-closure/notification-equality.test.ts`

## H1 durable MRTR acceptance

- `migrations/022_mrtr_response_inbox.sql`
- `packages/persistence-postgres/src/tasks.ts`
- `packages/task-engine/src/engine.ts`
- `tests/runtime-conformance-closure/mrtr-inbox.test.ts`
