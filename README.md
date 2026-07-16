# SDAR MCP Tasks Provider Runtime

An independently deployable, language-neutral Runtime for the SEP-2663 task lifecycle and the `io.sdar/taskExecution` Provider Profile. The Runtime is implemented in strict TypeScript and delegates resource facts and side effects to versioned gRPC/Protobuf Adapters.

The implementation follows [`SDAR_MCP_Tasks_Runtime_Codex_Goal_Task_Package_V1.0.md`](SDAR_MCP_Tasks_Runtime_Codex_Goal_Task_Package_V1.0.md). Normative design inputs are under [`references/`](references/), the living execution plan is [`docs/implementation/runtime-exec-plan.md`](docs/implementation/runtime-exec-plan.md), and delivery evidence is under [`reports/runtime-v1/`](reports/runtime-v1/).

## Runtime quick start

Prerequisites: Node.js 22, Corepack/pnpm 11, and Docker with Compose access.

```bash
corepack enable
pnpm install --frozen-lockfile
pnpm build
pnpm test:unit
pnpm test:contract
docker compose up --build --wait
curl --fail http://127.0.0.1:8080/health/ready
```

The default stack exposes Runtime HTTP on `:8080`, PostgreSQL on `:5432`, and an internal TypeScript Adapter on `:7001`. A Python Adapter image can be built with:

```bash
docker compose --profile python-adapter build adapter-python
```

Runtime startup applies migrations and runs durable scheduling/recovery before
readiness. The reference Adapter state and PostgreSQL data use named volumes.
For a release gate with PostgreSQL and Docker available, run:

```bash
TEST_DATABASE_URL=postgresql://sdar:sdar@127.0.0.1:5432/sdar_runtime_test pnpm verify
```

Configuration and security are documented in
[`configuration.md`](docs/operations/configuration.md) and
[`security-recovery.md`](docs/operations/security-recovery.md); deployment and
incident procedures are in the [`runbook`](docs/operations/runbook.md).

Adapter authors can run the dual-language P0-P4 workflow described in [`docs/conformance/adapter-testkit.md`](docs/conformance/adapter-testkit.md); its JSON reports use a published repository schema.

Adapter authors should begin with the
[`quick start`](docs/adapter/quick-start.md) and dual-language P0-P4 workflow in
[`adapter-testkit.md`](docs/conformance/adapter-testkit.md). API/RPC and state
semantics are summarized in [`api-reference.md`](docs/protocol/api-reference.md)
and [`state-reason-mapping.md`](docs/implementation/state-reason-mapping.md).

Production Kubernetes JSON manifests are under [`deploy/kubernetes`](deploy/kubernetes),
with migration/upgrade instructions in [`docs/database/upgrade.md`](docs/database/upgrade.md).
Root commands in `package.json` expose every release gate; `pnpm verify` includes
formatting, lint, types, build/Proto drift, audit/SBOM, deployment/container,
unit/contract/integration/recovery/security/E2E/conformance and capacity checks.
