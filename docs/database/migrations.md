# Database Migrations

Migrations are append-only SQL files under `migrations/`, ordered by numeric prefix. Runtime
acquires a PostgreSQL advisory lock, creates `runtime_schema_migration`, verifies the SHA-256
checksum of every applied file, and applies each new file in its own transaction. Checksums use
LF-normalized SQL so Linux and Windows checkouts share one published value; the verifier accepts
the raw checkout hash only when matching a legacy Windows record, and still rejects any content
change. T-047 pins the published 001-006 normalized hashes from rc.1.

`001_operation_snapshot.sql` creates immutable operation snapshots keyed by provider/version/operation/Manifest hash, with UUID primary key, JSON object checks, hash/name checks and lookup index. Reloading the same Manifest is idempotent; a changed Manifest produces a new snapshot instead of rewriting history.

`002_task_lifecycle.sql` creates the durable lifecycle core:

- `admission_intent` is written before StartOperation and records pending, rejected, published, or uncertain admission;
- `provider_task` is the authorization-bound current snapshot with optimistic versioning and irreversible terminal states enforced by repository transactions;
- `task_observation` records monotonic Adapter revisions, while `outbox_event` is committed in the same transaction as visible task state;
- `task_input_request`, `idempotency_record`, and `runtime_lease` reserve durable contracts used by later Profile phases.

The Runtime never returns a task identifier before `provider_task`, its initial observation, the creation outbox event, and the admission publication state commit together. Failed publication leaves only an `UNCERTAIN` admission intent for reconcile; it cannot leak a queryable half-created Task.

`003_idempotency.sql` evolves the reserved idempotency table without rewriting earlier migrations.
It adds pending/complete state, a stable pre-admission taskId, simulation identity, update time, a
pending-recovery index, and a payload consistency constraint. In rc.1 the repository held a
PostgreSQL session advisory lock over final admission. Migration 012 and the H7 repository
replace that connection-held execution window with a durable claim lease while retaining the
stable taskId for Reconcile.

`004_durable_timing.sql` permits a scheduled Task to exist before it has an external execution binding, adds durable not-before and scheduler claim fields, permits revision zero for the Runtime-created scheduling observation, and adds partial due/deadline indexes. Claims are database rows selected with `FOR UPDATE SKIP LOCKED`; an expired `STARTING` claim is eligible for another Runtime, so restart does not depend on an in-process timer.

`005_task_controls.sql` adds a per-Task command sequence, stable input-request description/required metadata, and the durable command journal for cancel, update, pause, and resume. Command intent and the matching outbox record commit before the Adapter RPC. Deadline workers allocate the same command sequence and journal entries as user cancellation, so the first persisted stop reason wins and a duplicate control request cannot create another Adapter side effect.

`006_recovery_hardening.sql` persists admission timing/TTL anchors needed to recover a response-lost start without a new client call, adds Task recovery attempt/audit fields, and creates partial recovery indexes. Recovery workers take a transaction-scoped PostgreSQL advisory lock per taskId to reconcile uncertain Admissions and nonterminal Tasks; command execution is handled by the Durable Command Dispatcher. Confirmed Adapter `NOT_FOUND` after an external binding becomes an explicit technical failure; transient unavailability leaves the last confirmed Task unchanged.

`007_durable_command_dispatch.sql` upgrades cancellation and mandatory-stop commands to a
recoverable dispatch state machine. It adds claim owner/expiry, attempt count, next-attempt
time, rejection diagnostics, stop priority/reason and the previous Task state needed for an
authoritative user-cancel rollback. Partial indexes enforce one active stop per Task and make
due work claimable by multiple Runtime instances. The migration removes the rc.1 global
request-hash uniqueness rule so a permanently rejected user cancellation can be followed by a
new stable command sequence, while retaining duplicate coalescing for active commands.

`008_start_window_and_schedule_retry.sql` persists the remaining start contract: the time a
safe-stop compensation was requested, the unique invocation attempt, and the next bounded
start-attempt time. It adds partial indexes for immediate watchdog scans, scheduled retries and
expired `STARTING` claims. Existing rc.1 rows retain their confirmed `actual_started_at` value;
scheduled rows start at attempt zero and receive attempt one only when a worker atomically
claims an actual Adapter call.

`009_observation_revision_and_outbox_keys.sql` separates the Runtime-owned monotonic
`observation_revision` from the Adapter Snapshot revision. It expands observations with
message, substate, progress, source and optional Adapter revision, and gives every outbox row a
globally unique stable event key. The rc.1 backfill preserves the highest recorded observation
revision, identifies the Runtime-created scheduled/window/control observations, and treats the
remaining historical Snapshot observations as Adapter-sourced. New lifecycle changes allocate
the next observation revision, update the current Task, append the complete observation and
insert the idempotent outbox event in one transaction.

`010_adapter_execution_identity.sql` enforces provider-scoped uniqueness for every non-null
external execution id. Start and recovery already bind a Task and execution in one publication
transaction; the unique partial index makes a second Task binding fail atomically even if an
Adapter violates its identity contract.

`011_task_handle_retention.sql` turns `ttl_ms` into an executable Task-handle lifecycle. It adds
the renewable handle expiry, terminal time, logical expiry, purge boundary and last Adapter
confirmation time. Existing active finite-TTL Tasks receive a fresh protected window during
upgrade; existing terminal Tasks retain their result for their stored TTL or the 24-hour default.
Partial indexes support batched `FOR UPDATE SKIP LOCKED` expiry and purge across Runtime replicas.

`012_idempotency_claim_lease.sql` replaces the connection-scoped advisory-lock execution window
with a durable owner/expiry claim and attempt counter. Existing PENDING rc.1/rc.2 rows receive an
already-due migration recovery lease; COMPLETE rows retain their payload and no lease. The new
partial index orders takeover work by lease expiry. Runtime claims in a short transaction,
performs Adapter work without a checked-out PoolClient, and completes with an owner CAS.

Runtime startup runs migrations. CI verifies an empty database, repeated startup, duplicate
Snapshot insertion, task lifecycle constraints, crash windows, applied-migration tamper
detection, and a complete 001-006 rc.1 fixture containing pending/uncertain admissions,
working/queued/input/stopping/scheduled/terminal Tasks, a pending command, observation/outbox and
idempotency data. After 007-012 it proves data/backfills and executes Recovery, Dispatcher and
Scheduler in startup order against PostgreSQL 17 and a real gRPC Adapter.

rc.2 repository code reads the committed Task through the same client used for the publication
transaction, then releases it. This is a runtime access-pattern fix and requires no schema
migration; it prevents a one-connection pool from deadlocking after a successful `COMMIT`.
