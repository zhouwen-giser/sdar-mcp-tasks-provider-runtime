# Database Migrations

Migrations are append-only SQL files under `migrations/`, ordered by numeric prefix. Runtime acquires a PostgreSQL advisory lock, creates `runtime_schema_migration`, verifies the SHA-256 checksum of every applied file, and applies each new file in its own transaction.

`001_operation_snapshot.sql` creates immutable operation snapshots keyed by provider/version/operation/Manifest hash, with UUID primary key, JSON object checks, hash/name checks and lookup index. Reloading the same Manifest is idempotent; a changed Manifest produces a new snapshot instead of rewriting history.

`002_task_lifecycle.sql` creates the durable lifecycle core:

- `admission_intent` is written before StartOperation and records pending, rejected, published, or uncertain admission;
- `provider_task` is the authorization-bound current snapshot with optimistic versioning and irreversible terminal states enforced by repository transactions;
- `task_observation` records monotonic Adapter revisions, while `outbox_event` is committed in the same transaction as visible task state;
- `task_input_request`, `idempotency_record`, and `runtime_lease` reserve durable contracts used by later Profile phases.

The Runtime never returns a task identifier before `provider_task`, its initial observation, the creation outbox event, and the admission publication state commit together. Failed publication leaves only an `UNCERTAIN` admission intent for reconcile; it cannot leak a queryable half-created Task.

`003_idempotency.sql` evolves the reserved idempotency table without rewriting earlier migrations. It adds pending/complete state, a stable pre-admission taskId, simulation identity, update time, a pending-recovery index, and a payload consistency constraint. The repository holds a PostgreSQL advisory lock scoped to authorization, operation, key, execution mode, and simulation while it performs final admission. Competing Runtime instances therefore observe one stored result/taskId and cannot create duplicate Adapter side effects. A process crash releases the database session lock while retaining the pending stable taskId for Reconcile.

`004_durable_timing.sql` permits a scheduled Task to exist before it has an external execution binding, adds durable not-before and scheduler claim fields, permits revision zero for the Runtime-created scheduling observation, and adds partial due/deadline indexes. Claims are database rows selected with `FOR UPDATE SKIP LOCKED`; an expired `STARTING` claim is eligible for another Runtime, so restart does not depend on an in-process timer.

Runtime startup runs migrations. CI verifies an empty database, repeated startup, duplicate Snapshot insertion, task lifecycle constraints, crash windows, and applied-migration tamper detection against real PostgreSQL 17.
