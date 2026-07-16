# Database Migrations

Migrations are append-only SQL files under `migrations/`, ordered by numeric prefix. Runtime acquires a PostgreSQL advisory lock, creates `runtime_schema_migration`, verifies the SHA-256 checksum of every applied file, and applies each new file in its own transaction.

`001_operation_snapshot.sql` creates immutable operation snapshots keyed by provider/version/operation/Manifest hash, with UUID primary key, JSON object checks, hash/name checks and lookup index. Reloading the same Manifest is idempotent; a changed Manifest produces a new snapshot instead of rewriting history.

Runtime startup runs migrations. CI verifies an empty database, repeated startup, duplicate Snapshot insertion and applied-migration tamper detection against real PostgreSQL 17.
