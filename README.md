# SDAR MCP Tasks Provider Runtime

An independently deployable, language-neutral Runtime for the SEP-2663 task lifecycle and the `io.sdar/taskExecution` Provider Profile. The Runtime is implemented in strict TypeScript and delegates resource facts and side effects to versioned gRPC/Protobuf Adapters.

The current release is `v1.1.0`, adding fail-safe Provider Ops Telemetry without changing Runtime
business semantics. Its live plan is
[`runtime-v1.1-telemetry-exec-plan.md`](docs/implementation/runtime-v1.1-telemetry-exec-plan.md).
Published `v1.0.0-rc.2` and `v1.0.0-rc.3` migrations, reports, tags, and release history remain
immutable.

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
TEST_DATABASE_URL=postgresql://sdar:sdar@127.0.0.1:5432/sdar_runtime_test pnpm verify:rc3
```

Configuration and security are documented in
[`configuration.md`](docs/operations/configuration.md) and
[`security-recovery.md`](docs/operations/security-recovery.md); deployment and
incident procedures are in the [`runbook`](docs/operations/runbook.md). OTLP signal contracts,
privacy rules and failure behavior are in
[`provider-ops-telemetry.md`](docs/operations/provider-ops-telemetry.md).
The signal architecture and Provider-facing gRPC contract are documented in
[`observability.md`](docs/architecture/observability.md) and
[`provider-telemetry-ingress.md`](docs/protocol/provider-telemetry-ingress.md).

Adapter authors should begin with the
[`quick start`](docs/adapter/quick-start.md) and dual-language expanded Adapter
protocol workflow in
[`adapter-testkit.md`](docs/conformance/adapter-testkit.md). API/RPC and state
semantics are summarized in [`api-reference.md`](docs/protocol/api-reference.md)
and [`state-reason-mapping.md`](docs/implementation/state-reason-mapping.md).
The machine reports mark Runtime Profile coverage `partial` and real-resource
safety `not_claimed`; a Mock Adapter result is not production qualification.
Both mock Adapters include Provider telemetry clients and examples for resource state/metric/health,
Task-bound execution progress, and replaying the same Provider event id after an uncertain call.
This Provider-to-Runtime service requires no Provider-side OpenTelemetry SDK.

Production Kubernetes JSON manifests are under [`deploy/kubernetes`](deploy/kubernetes),
with migration/upgrade instructions in [`docs/database/upgrade.md`](docs/database/upgrade.md).
Root commands in `package.json` expose every release gate; `pnpm verify:v1.1` includes
formatting, lint, types, build/Proto drift, audit/SBOM, deployment/container,
unit/contract/integration/recovery/security/E2E/conformance, the six rc.1 red-regression guards,
and the rc.3 capacity checks. CI additionally runs Buf lint/breaking against the immutable rc.1
tag and builds the Runtime plus both Adapter images with Compose.
