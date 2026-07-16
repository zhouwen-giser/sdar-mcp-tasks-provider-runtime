# Performance and capacity baseline

`pnpm capacity:baseline` runs a single official MCP Streamable HTTP client
against one Runtime, one TypeScript Adapter and PostgreSQL 17. It measures 100
sequential synchronous Tool calls and 25 durable Task create-plus-get lifecycles,
then writes CPU/memory/topology, throughput and p50/p95/p99/max latency to
`reports/capacity/runtime-v1.json`.

This is a reproducible regression baseline, not a production load limit. It has
no network concurrency, resource-side latency, event consumer or multi-tenant
contention. Use the Kubernetes starting point of 250m CPU/256 MiB request and
1 CPU/512 MiB limit per Runtime replica, PostgreSQL pool maximum 10 per replica,
then load-test the real Adapter and database before setting SLOs. Scale HTTP
replicas horizontally; size PostgreSQL for connection count, Task/observation
write rate and Outbox retention. Tune poll intervals only after measuring claim
load and recovery latency.

The authoritative RC measurement is generated in GitHub Actions with the exact
release dependencies and uploaded as release evidence. A material regression in
the same runner/topology must be explained even when functional verification
still passes.

H7 also records the production runtime image baseline at
`reports/image/runtime-v1-rc2.json`. The audit compares two build filesystem/config shapes,
requires the `node` user, rejects development/test/documentation payloads and enforces a 150 MB
compressed image ceiling. This is a regression guard, not a universal deployment limit.
