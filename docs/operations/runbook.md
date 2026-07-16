# Runtime operations runbook

## Startup and health

Startup applies checksum-protected migrations, validates Adapter Manifest and
provider identity, persists operation snapshots, performs the first recovery
scan, and only then listens. `/health/live` proves the event loop can respond;
`/health/ready` additionally reports `database`, `adapter`, and `recovery`.
Remove a replica from traffic on any non-ready dependency.

Use `/metrics` for Prometheus scraping. Alert on sustained readiness failure,
growth in `sdar_outbox_pending`, Adapter RPC error outcomes, recovery errors,
rate limiting, and unexpected terminal-failed growth. Correlate structured logs
by `providerId`, `taskId`, `operationName`, execution mode and correlation id;
arguments, credentials and bearer tokens are intentionally absent/redacted.

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
