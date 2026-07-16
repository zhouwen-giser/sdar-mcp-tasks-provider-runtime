# Phase R8 Implementation Report

- Start SHA: `687949d`
- Upstream main at pre-commit fetch: `7e501d07786a7695d205b0bc92b8fdbd667e7f96`
- Phase/end SHA: pending

R8 completes the TypeScript and Python reference Adapters with identical Manifest, Availability, synchronous/task-capable/task-required Start/Get, cancel, update/input, pause/resume and Reconcile behavior.

Both Adapters persist execution identity, Snapshots, terminal proof, input round and command Ack journal in atomic mode-0600 JSON files. A new process using the same `ADAPTER_STATE_PATH` must reconcile the seeded task, proving that process memory is not the execution authority.

The reusable Testkit drives the official MCP Streamable HTTP client, gRPC gateway, real PostgreSQL Task Engine and durable scheduler. It emits schema-defined P0-P4 JSON reports for each language and covers capability/catalog, Availability, scheduling, multi-round input, cancellation, idempotency/conflict, response loss, restart, terminal irreversibility and duplicate Outbox delivery.

Exit decision: pending authoritative dual-language CI.
