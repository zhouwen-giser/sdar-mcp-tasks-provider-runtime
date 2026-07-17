# Adapter Conformance Testkit

`pnpm test:conformance` builds the Runtime/Testkit, requires `TEST_DATABASE_URL`, starts both
reference Adapters, proves each execution store survives an Adapter process restart, and runs
the identical 17-case Adapter protocol/Runtime integration suite through gRPC, PostgreSQL, Task
Engine, and an official MCP Streamable HTTP client.

The machine report schema is `packages/conformance-testkit/report.schema.json`. Reports are
written to `reports/conformance/typescript.json` and `reports/conformance/python.json`, validated
before publication, and uploaded by CI as `conformance-reports`.

Every report has three non-interchangeable scopes:

- Adapter protocol: `passed` only when identity, command sequence, response loss, retry/reject,
  output, input and process-restart cases pass;
- Runtime Profile: `partial`; repository T-001..T-047 adds broader evidence, but this Testkit
  does not claim every Provider Profile clause;
- resource-specific safety: `not_claimed`; Mock Adapters cannot qualify real resource effects.

Groups are cumulative:

- P0 clauses: protocol/catalog, synchronous Tool, persisted task-required lifecycle and terminal read;
- P1 clauses: all four Availability states, risk, validity and windows;
- P2 clauses: durable not-early scheduling and retryable start rejection identity;
- P3 clauses: restricted accept/reject without ambiguous Task and pause/resume working state;
- P4 clauses: input rounds, cancellation, idempotency, response loss, identity/sequence conflict,
  output mismatch, safe-stop rejection/transport failure, restart binding and terminal/Outbox
  irreversibility.

Both examples store execution binding, full Snapshot, terminal proof, input round, and command Ack journal in an atomic mode-0600 JSON file. The TypeScript and Python processes do not use an in-memory Map/dictionary as execution authority. `ADAPTER_STATE_PATH` selects the durable file; restart tests deliberately reuse it.

The rc.2 release gate validates both JSON reports against the executable schema, requires at
least 17 cases per language and rejects a report that promotes Runtime Profile or resource safety
beyond these scopes. `pnpm verify:rc2` also runs the independent Runtime integration, recovery,
security, wire and capacity matrix.
