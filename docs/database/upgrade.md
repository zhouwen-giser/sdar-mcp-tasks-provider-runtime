# Migration and upgrade procedure

rc.1 contains published migrations `001` through `006`; rc.2 appends `007` through `012`.
Published files are immutable: Runtime records an LF-normalized SHA-256 checksum and refuses
startup if content changes, while accepting an exact legacy raw-checkout hash already recorded
by older Windows installations. Never edit, delete or renumber 001-012.

1. Verify a restorable, consistent PostgreSQL backup and Adapter compatibility.
2. Install dependencies/build the exact release and run tests against a restored
   staging copy.
3. Apply migrations once with `DATABASE_URL=... pnpm db:migrate`, or run the
   release image with command `node dist/apps/runtime/src/migrate.js`.
4. Check the returned version/checksum list, then roll Runtime replicas with
   `maxUnavailable=0` and watch readiness/recovery/Adapter metrics.
5. Run an MCP synchronous call and a durable Task smoke before completing the
   rollout.
6. Confirm Recovery, command dispatcher, scheduler and TTL cleaner readiness; inspect pending
   command, STARTING/SCHEDULED, expired-handle and Outbox counts before declaring success.

CI constructs an actual rc.1 database at 001-006 with admissions, all nonterminal/terminal Task
classes, command, Observation, Outbox, idempotency and real Adapter snapshot data. It then applies
007-012 twice and proves Recovery -> Dispatcher -> Scheduler continuation plus historical reads.

The migrator serializes through a PostgreSQL advisory lock, so concurrent
invocations are safe. Runtime also invokes it during startup. There is no
automatic down migration: application rollback is permitted only while the old
binary understands every applied schema. Otherwise restore the pre-upgrade
backup to a separate database and reconcile external Adapter executions before
cutover.
