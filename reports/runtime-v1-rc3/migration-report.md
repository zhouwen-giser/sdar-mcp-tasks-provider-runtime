# v1.0.0-rc.3 Migration Report

Date: 2026-07-17

Verified implementation commit: `f658bdc`

Result: PASS

Published rc.1 migrations 001-006 and rc.2 migrations 007-012 were not edited. rc.3 appends:

- `013_single_claimed_command.sql`
- `014_observation_pagination.sql`
- `014_start_confirmation_watchdog.sql`
- `015_recovery_backoff.sql`

The migrator applied all 16 files with checksum recording and a PostgreSQL advisory lock. The
release gate covered an empty schema, repeated idempotent application, the complete rc.1
full-state fixture, the pre-012 idempotency fixture, and a dedicated rc.2 fixture containing a
bound unconfirmed Task, Observation and claimed command. The rc.2 fixture verified:

- the one-claimed-command constraint and owner/expiry consistency;
- start-confirmation deadline backfill;
- the descending Observation index;
- recovery due-time/failure-count defaults and index;
- rejection of a second claimed command for the same Task;
- a second migration run with no drift.

The integration suite completed 77 tests, including both multi-replica race suites. No down
migration was introduced; rollback continues to require an old-binary compatibility check or a
restored pre-upgrade database.
