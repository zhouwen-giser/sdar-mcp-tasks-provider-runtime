# SDAR MCP Tasks Provider Runtime

An independently deployable, language-neutral Runtime for the SEP-2663 task lifecycle and the `io.sdar/taskExecution` Provider Profile. The Runtime is implemented in strict TypeScript and delegates resource facts and side effects to versioned gRPC/Protobuf Adapters.

The current release candidate is `v1.0.0-rc.2`. Its hardening plan and traceability matrix are
[`runtime-rc2-hardening-exec-plan.md`](docs/implementation/runtime-rc2-hardening-exec-plan.md)
and
[`runtime-rc2-requirement-traceability.md`](docs/implementation/runtime-rc2-requirement-traceability.md);
phase and final evidence is under [`reports/runtime-v1-rc2/`](reports/runtime-v1-rc2/).

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
TEST_DATABASE_URL=postgresql://sdar:sdar@127.0.0.1:5432/sdar_runtime_test pnpm verify:rc2
```

Configuration and security are documented in
[`configuration.md`](docs/operations/configuration.md) and
[`security-recovery.md`](docs/operations/security-recovery.md); deployment and
incident procedures are in the [`runbook`](docs/operations/runbook.md).

Adapter authors should begin with the
[`quick start`](docs/adapter/quick-start.md) and dual-language expanded Adapter
protocol workflow in
[`adapter-testkit.md`](docs/conformance/adapter-testkit.md). API/RPC and state
semantics are summarized in [`api-reference.md`](docs/protocol/api-reference.md)
and [`state-reason-mapping.md`](docs/implementation/state-reason-mapping.md).
The machine reports mark Runtime Profile coverage `partial` and real-resource
safety `not_claimed`; a Mock Adapter result is not production qualification.

Production Kubernetes JSON manifests are under [`deploy/kubernetes`](deploy/kubernetes),
with migration/upgrade instructions in [`docs/database/upgrade.md`](docs/database/upgrade.md).
Root commands in `package.json` expose every release gate; `pnpm verify:rc2` includes
formatting, lint, types, build/Proto drift, audit/SBOM, deployment/container,
unit/contract/integration/recovery/security/E2E/conformance, the six rc.1 red-regression guards,
and the expanded capacity checks. CI additionally runs Buf lint/breaking against the immutable
rc.1 tag and builds the Runtime plus both Adapter images with Compose.
