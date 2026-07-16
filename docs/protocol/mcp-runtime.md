# MCP Runtime Boundary

The Streamable HTTP endpoint is `POST /mcp`. It uses the official TypeScript MCP SDK while every SDK import remains inside `packages/mcp-protocol`.

At startup Runtime calls Adapter DescribeProvider, validates and hashes the Manifest, persists immutable operation snapshots, and builds one Tool per operation. Resource instances remain Tool arguments and never expand the catalog.

Initialization declares Tools and both task extensions. Profile booleans are derived from Runtime support and loaded operation capabilities. Every Tool publishes `_meta["io.sdar/taskExecution"]` with execution mode and supported scheduling, elapsed-time, observation, input, cancellation and idempotency features.

Synchronous StartOperation completes as an ordinary Tool result. `task_required` always publishes a durable SEP-2663 Task after Adapter acceptance. `task_capable` returns an ordinary result when its initial Snapshot is terminal and otherwise follows the same durable publication path. Rejection becomes `CallToolResult.isError=true` with `admission_rejected` and never creates a Task.

`tasks/get` binds taskId to the trusted authorization-context hash, execution mode, and simulation identity. Nonterminal reads perform the safe Adapter `GetExecution` RPC, apply only a greater observation revision, and atomically update task/outbox/observation data. Once a terminal state is stored, later Adapter observations cannot reverse it. Business failure and partial completion remain MCP `completed` with structured outcome data; only technical failure uses MCP `failed`.

The low-level official SDK Server is intentional because Adapter input/output documents are validated JSON Schema Draft 2020-12, whereas the high-level registration API accepts application-owned Zod schemas. SDK types do not enter domain, registry or persistence packages.
