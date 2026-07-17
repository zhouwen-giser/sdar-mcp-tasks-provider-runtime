# Runtime operations runbook

## Startup and health

Startup applies checksum-protected migrations, validates Adapter Manifest and
provider identity, persists operation snapshots, performs the first recovery
scan, and only then listens. `/health/live` proves the event loop can respond;
`/health/ready` additionally reports `database`, `adapter`, `recovery`, `scheduler`,
`commandDispatcher`, and `ttlCleaner` independently.
Remove a replica from traffic on any non-ready dependency.

Adapter readiness is a continuous identity-checked probe, not a startup latch. Adapter Manifest
readiness separately compares the current validated hash with the startup hash and latches drift
as failed until restart. An Adapter outage
must change only `adapter` to failed while a successful PostgreSQL probe keeps `database` ready;
recovery is automatic after a valid probe. Scheduler/dispatcher/cleaner failures retain their
own component label. Liveness remains 200 during ordinary dependency outages.

Use `/metrics` for Prometheus scraping. Alert on sustained readiness failure,
growth in `sdar_outbox_pending`, Adapter RPC error outcomes, recovery errors,
rate limiting, and unexpected terminal-failed growth. Correlate structured logs
by `providerId`, `taskId`, `operationName`, execution mode and correlation id;
arguments, credentials and bearer tokens are intentionally absent/redacted.

An Outbox publisher readiness failure means committed lifecycle events remain pending. Restore
the webhook or intentionally select the internal sink; do not bypass unpublished rows to force
TTL purge.

## Routine operations

- Back up PostgreSQL using the platform's physical or verified logical backup;
  Task, intent, command, observation, snapshot, idempotency and Outbox tables
  form one recovery unit.
- Run `pnpm db:migrate` or the image's migration entry point before a rolling
  upgrade. Multiple invocations serialize on an advisory lock.
- Keep at least two Runtime replicas. Scheduler and recovery work is coordinated
  with PostgreSQL row/advisory locks, so replicas may overlap safely.
- Drain HTTP traffic before termination. A process exit does not lose durable
  tasks; another replica or restarted process scans them.
- Streamable HTTP is stateless: do not configure sticky sessions, expect an
  `Mcp-Session-Id`, or depend on GET/DELETE/resumable notifications in rc.2.
- Before rc.2 rollout, run `pnpm verify:rc2`, Buf breaking against `v1.0.0-rc.1`, and the
  three-image Compose build. Archive conformance, capacity, SBOM and image JSON as evidence.
- Size `DATABASE_POOL_MAX` for replicas and probes. The capacity gate proves a max-one pool can
  make SQL progress during a slow Adapter RPC; rising pool waiters still require investigation.

## Incident procedures

For PostgreSQL failure, keep replicas out of readiness, restore connectivity or
the entire consistent backup, and verify migration checksums before admitting
traffic. For Adapter failure, do not delete Runtime tasks: transient reconcile
retains the last fact and retries; a proven `NOT_FOUND` becomes explicit failure.
For response-loss or process crash, restart normally and inspect recovery and
Adapter RPC metrics. Do not manually mark a Task completed unless both the
resource authority and database history have been independently reconciled.

For an Outbox backlog, repair the publisher/consumer and redeliver unpublished
rows; event ids and observation revisions are idempotency keys. For suspected
credential exposure, rotate JWT/database/mTLS secrets, restart replicas, and
audit authentication failures without logging the secret values.

## Rollback

Application rollback is allowed only to a version documented as compatible with
all applied migrations and the Adapter protocol. SQL migrations are append-only;
never delete a migration row or edit an applied file. Restore a pre-upgrade
backup in an isolated database when a schema rollback is unavoidable.
