# MCP Runtime Boundary

The Streamable HTTP endpoint is `POST /mcp`. It uses the official TypeScript MCP SDK while every SDK import remains inside `packages/mcp-protocol`.

At startup Runtime calls Adapter DescribeProvider, validates and hashes the Manifest, persists immutable operation snapshots, and builds one Tool per operation. Resource instances remain Tool arguments and never expand the catalog.

Initialization declares Tools and both task extensions. Profile booleans are derived from Runtime support and loaded operation capabilities. Every Tool publishes `_meta["io.sdar/taskExecution"]` with execution mode and supported scheduling, elapsed-time, observation, input, cancellation and idempotency features.

R2 supports synchronous StartOperation end-to-end. Rejection becomes `CallToolResult.isError=true` with `admission_rejected`; an accepted terminal SUCCEEDED Snapshot becomes an ordinary successful Tool result. Nonterminal/task publication is rejected until R3 installs the persistent Task Engine.

The low-level official SDK Server is intentional because Adapter input/output documents are validated JSON Schema Draft 2020-12, whereas the high-level registration API accepts application-owned Zod schemas. SDK types do not enter domain, registry or persistence packages.
