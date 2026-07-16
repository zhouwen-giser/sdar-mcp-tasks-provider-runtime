# Adapter Conformance Testkit

`pnpm test:conformance` builds the Runtime/Testkit, requires `TEST_DATABASE_URL`, starts both reference Adapters, proves each execution store survives an Adapter process restart, and runs the identical Profile suite through gRPC, PostgreSQL, Task Engine, and an official MCP Streamable HTTP client.

The machine report schema is `packages/conformance-testkit/report.schema.json`. Reports are written to `reports/conformance/typescript.json` and `reports/conformance/python.json`, and CI uploads the same files as `conformance-reports`.

Groups are cumulative:

- P0: protocol/Manifest, dynamic MCP Tool catalog, synchronous and task-required lifecycle;
- P1: batch Availability states and restricted evidence;
- P2: persistent scheduled start with injected Clock and no early execution;
- P3: multi-round input, Ack-only cancel, duplicate commands, idempotency and conflicts;
- P4: response-loss Reconcile, durable Adapter restart binding, protocol identity conflict, terminal irreversibility, and duplicate Outbox delivery.

Both examples store execution binding, full Snapshot, terminal proof, input round, and command Ack journal in an atomic mode-0600 JSON file. The TypeScript and Python processes do not use an in-memory Map/dictionary as execution authority. `ADAPTER_STATE_PATH` selects the durable file; restart tests deliberately reuse it.
