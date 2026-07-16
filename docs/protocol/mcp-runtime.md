# MCP Runtime Boundary

The Streamable HTTP endpoint is `POST /mcp`. It uses the official TypeScript MCP SDK while every SDK import remains inside `packages/mcp-protocol`.

At startup Runtime calls Adapter DescribeProvider, validates and hashes the Manifest, persists immutable operation snapshots, and builds one Tool per operation. Resource instances remain Tool arguments and never expand the catalog.

Initialization declares Tools and both task extensions. Profile booleans are derived from Runtime support and loaded operation capabilities. Every Tool publishes `_meta["io.sdar/taskExecution"]` with execution mode and supported scheduling, elapsed-time, observation, input, cancellation and idempotency features.

Synchronous StartOperation completes as an ordinary Tool result. `task_required` always publishes a durable SEP-2663 Task after Adapter acceptance. `task_capable` returns an ordinary result when its initial Snapshot is terminal and otherwise follows the same durable publication path. Rejection becomes `CallToolResult.isError=true` with `admission_rejected` and never creates a Task.

`tasks/get` binds taskId to the trusted authorization-context hash, execution mode, and simulation identity. Nonterminal reads perform the safe Adapter `GetExecution` RPC, apply only a greater observation revision, and atomically update task/outbox/observation data. Once a terminal state is stored, later Adapter observations cannot reverse it. Business failure and partial completion remain MCP `completed` with structured outcome data; only technical failure uses MCP `failed`.

`io.sdar/taskExecution/checkAvailability` accepts 1–128 independent checks. Runtime validates operation support and known arguments, then performs one Adapter batch RPC with trusted execution context. Results must preserve request identity, use one of four Profile states, keep `validUntil` at or after `checkedAt`, and provide the required restricted-risk/effect fields and ordered valid windows. A transport failure yields explicit per-check `unknown`; it never claims `available` and never reserves a resource.

When `tools/call.params._meta["io.sdar/taskExecution"].idempotencyKey` is present, Runtime binds the canonical deep argument hash to authorization, operation, mode, and simulation. Duplicate synchronous calls return the stored Tool result; duplicate task calls return the original immediately queryable taskId. A different argument hash is a conflict. Pending calls reuse the stable taskId and Reconcile before a safe retry.

The same Profile metadata carries `timing`. Runtime validates zoned RFC 3339 scheduled time, nonnegative integer start tolerance, positive-or-null max elapsed, and Manifest capability agreement. Scheduled calls publish a durable Task immediately and do not call StartOperation before `scheduledAt`. Database workers atomically claim due rows; missing the latest-start boundary completes with `start_window_missed` without Adapter side effects. Deadline workers persist `STOPPING` before RequestCancel and wait for a later Adapter Snapshot before publishing the `deadline_reached` completed result. `maxElapsedMs=null` stores no deadline.

Official `tasks/cancel` is Ack-only: Runtime first journals a CANCEL command and publishes `working/stopping`, then sends RequestCancel. Only a later, greater Adapter Snapshot publishes `cancelled`; a concurrent natural success remains `completed`. Deadline and user cancellation share this journal, preserving the first stop reason. Profile `tasks/update` validates only open stable input keys against their stored Draft 2020-12 schemas, journals an UPDATE command, and returns an empty Ack; the next Adapter Snapshot determines whether the Task remains `input_required`. Repeated equal answers and repeated cancellation are side-effect free, while conflicting or unknown inputs fail before gRPC.

When declared by the operation, Profile pause/resume methods journal conditional Adapter commands and expose their substates through ordinary `working` Tasks. Every greater Adapter revision is inserted once, in ascending order, in the same transaction as current Task state and an outbox event. Delivery attempts are independent of `tasks/get`, so notification failure cannot corrupt query correctness.

The low-level official SDK Server is intentional because Adapter input/output documents are validated JSON Schema Draft 2020-12, whereas the high-level registration API accepts application-owned Zod schemas. SDK types do not enter domain, registry or persistence packages.
