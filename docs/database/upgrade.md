# Migration and upgrade procedure

V1.0 RC contains migrations `001` through `006`. Files are immutable after
release: Runtime records each SHA-256 checksum and refuses startup if an applied
file changes. New releases add a higher numeric file and must remain compatible
with a rolling deployment.

1. Verify a restorable, consistent PostgreSQL backup and Adapter compatibility.
2. Install dependencies/build the exact release and run tests against a restored
   staging copy.
3. Apply migrations once with `DATABASE_URL=... pnpm db:migrate`, or run the
   release image with command `node dist/apps/runtime/src/migrate.js`.
4. Check the returned version/checksum list, then roll Runtime replicas with
   `maxUnavailable=0` and watch readiness/recovery/Adapter metrics.
5. Run an MCP synchronous call and a durable Task smoke before completing the
   rollout.

The migrator serializes through a PostgreSQL advisory lock, so concurrent
invocations are safe. Runtime also invokes it during startup. There is no
automatic down migration: application rollback is permitted only while the old
binary understands every applied schema. Otherwise restore the pre-upgrade
backup to a separate database and reconcile external Adapter executions before
cutover.
