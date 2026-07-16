# Adapter quick start

An Adapter owns resource truth and side effects; Runtime owns MCP, Task,
scheduling, authorization binding and recovery semantics. Start from either
`examples/mock-adapter-typescript` or `examples/mock-adapter-python`. Both use
the same `proto/io/sdar/mcp/tasks/adapter/v1/adapter.proto` and pass the same
P0-P4 suite.

1. Choose a stable `providerId` and a bounded set of resource-type operations.
   Resource instances belong in arguments; never create one operation per item.
2. Implement `DescribeProvider`, `CheckAvailability`, `StartOperation`,
   `GetExecution`, `RequestCancel`, and `ReconcileExecution`. Implement update,
   pause/resume, events or inventory only when the Manifest declares them.
3. Persist `taskId`, canonical argument hash, authorization-context hash,
   execution mode/simulation id, external execution id, latest Snapshot revision,
   terminal proof and every command sequence in the resource system of record.
4. Make `StartOperation` idempotent by `taskId`. The same identity returns the
   existing execution; a mismatched binding is a conflict. Reconcile performs no
   side effect. Cancel/update/pause/resume acknowledgements are not terminal
   proof and must be replay-safe by command sequence.
5. Increment Snapshot revision monotonically, retain input-request keys until
   answered, and never regress a terminal execution.

Generate TypeScript bindings with `pnpm proto:generate`. The Python image runs
`grpcio-tools` against the same IDL. To validate a reachable implementation,
adapt `scripts/run-conformance.mjs` with its endpoint/process launcher and run:

```bash
TEST_DATABASE_URL=postgresql://... pnpm test:conformance
```

The required machine output conforms to
`packages/conformance-testkit/report.schema.json`. A provider is not compatible
until P0–P4 all pass, including process replacement on the same durable state,
response-loss Reconcile, identity conflict and terminal/Outbox idempotency.
