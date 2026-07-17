# Runtime API and Adapter RPC reference

## HTTP

| Method and path          | Purpose                                                   |
| ------------------------ | --------------------------------------------------------- |
| `POST /mcp`              | Official MCP Streamable HTTP JSON-RPC endpoint            |
| `GET /health/live`       | Process liveness                                          |
| `GET /health/ready`      | Database/Adapter/recovery readiness                       |
| `GET /metrics`           | Prometheus text exposition                                |
| `GET /internal/provider` | Loaded validated Adapter Manifest; operational inspection |

`/mcp` supports MCP initialization and `tools/list`, `tools/call`,
`tasks/get`, `tasks/result`, and `tasks/cancel`, plus Profile methods
`io.sdar/taskExecution/checkAvailability`, `tasks/update`, `tasks/pause`, and
`tasks/resume` when applicable. Tool definitions and capability metadata come
from the startup Manifest snapshot. Authentication is described in the
configuration reference.

`POST /mcp` is stateless. Responses do not issue `Mcp-Session-Id`; repeated requests and multiple
clients may reach any replica. Runtime does not support Streamable HTTP GET/DELETE session
lifecycle, SSE resumption/event storage, or `notifications/tasks` in rc.2.

Task TTL is handle retention, not an execution deadline. Active Tasks are never expired and a
finite active handle is renewed by lifecycle activity or the TTL cleaner. Terminal Tasks remain
queryable until `terminalAt + ttl`; an omitted terminal TTL uses at least 24 hours. An authorized
request after expiry receives JSON-RPC Invalid Params with `reasonCode=TASK_EXPIRED`; an
unauthorized caller receives the same not-found behavior as for an unknown Task.

The official Task fields are top-level `ttl` and `pollInterval`. SDAR compatibility aliases are
only `_meta["io.sdar/taskExecution"].ttlMs` and `pollIntervalMs`; `ttlMs` and `pollIntervalMs`
are never emitted as arbitrary top-level fields. Client TTL must be a safe integer from 1 through
31,536,000,000 milliseconds. `pollInterval` is the persisted Runtime polling recommendation and
does not control scheduling, max elapsed time or deadline behavior.

Each advertised Tool output schema accepts the Adapter's raw success document and the
standardized business-result envelope. Runtime validates synchronous, task-capable inline,
asynchronous and partial Adapter payloads before publication, including 1 MiB/depth-32/10,000-node
JSON limits. An invalid success becomes a technical contract failure with
`reasonCode=ADAPTER_OUTPUT_SCHEMA_MISMATCH`; it is never returned as successful structured
content.

Unknown/hidden/expired Tasks, unknown Tools, malformed TTL/timing/input and unsupported
capabilities return JSON-RPC Invalid Params with stable `data.reasonCode`. Technical failure
before Task publication returns JSON-RPC Internal Error. A published technical failure is
`status=failed` with a Profile error object; business failure and partial completion are
`status=completed` and their Tool result uses `isError=true`.

For a nonterminal `tasks/get`, a transient Adapter transport failure returns the persisted Task
instead of changing it to failed. `_meta["io.sdar/taskExecution"]` then contains
`snapshotFreshness="stale"`, `lastConfirmedAt` and `degradedReasonCode`. Identity mismatch,
non-monotonic/invalid Snapshot and other Adapter contract failures are never converted to stale
success.

## Adapter gRPC v1

| RPC                                  | Requirement | Contract                                              |
| ------------------------------------ | ----------- | ----------------------------------------------------- |
| `DescribeProvider`                   | mandatory   | Versioned Manifest and finite Operation catalog       |
| `CheckAvailability`                  | mandatory   | Batched predictive four-state checks                  |
| `StartOperation`                     | mandatory   | Idempotent admission/start by stable identity         |
| `GetExecution`                       | mandatory   | Current authoritative Snapshot                        |
| `RequestCancel`                      | mandatory   | Replay-safe acknowledgement; not terminal proof       |
| `ReconcileExecution`                 | mandatory   | Side-effect-free FOUND/NOT_FOUND/TRANSIENT/CONFLICT   |
| `UpdateExecution`                    | conditional | Stable input answers and command sequence             |
| `PauseExecution` / `ResumeExecution` | conditional | Replay-safe control acknowledgements                  |
| `StreamExecutionEvents`              | optional    | Optimization; polling/reconcile remains authoritative |
| `ListResources`                      | optional    | Inventory only; never changes Tool cardinality        |

The authoritative field definitions, enums and compatibility comments are in
`adapter.proto`; committed generated TypeScript bindings must match
`pnpm proto:check`. Additive field evolution is allowed within protocol v1;
renumbering/removing fields or changing identity semantics requires a new major
protocol version.

## rc.2 verification boundary

`pnpm verify:rc2` is the aggregate Runtime gate. Adapter protocol reports qualify the reference
TypeScript and Python implementations only; they mark Runtime Profile coverage `partial` and
real-resource safety `not_claimed`. Production Adapters must separately prove resource-specific
side-effect identity and safe-stop behavior.
