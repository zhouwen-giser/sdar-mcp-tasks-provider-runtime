# SDAR MCP Tasks Provider Runtime

An independently deployable, language-neutral Runtime for the SEP-2663 task lifecycle and the `io.sdar/taskExecution` Provider Profile. The Runtime is implemented in strict TypeScript and delegates resource facts and side effects to versioned gRPC/Protobuf Adapters.

The implementation follows [`SDAR_MCP_Tasks_Runtime_Codex_Goal_Task_Package_V1.0.md`](SDAR_MCP_Tasks_Runtime_Codex_Goal_Task_Package_V1.0.md). Normative design inputs are under [`references/`](references/), the living execution plan is [`docs/implementation/runtime-exec-plan.md`](docs/implementation/runtime-exec-plan.md), and delivery evidence is under [`reports/runtime-v1/`](reports/runtime-v1/).

## R1 foundation quick start

Prerequisites: Node.js 22, Corepack/pnpm 11, and Docker with Compose access.

```bash
corepack enable
pnpm install --frozen-lockfile
pnpm build
pnpm test:unit
pnpm test:contract
pnpm test:integration
docker compose up --build --wait
curl --fail http://127.0.0.1:8080/health/ready
```

The default stack exposes Runtime HTTP on `:8080`, PostgreSQL on `:5432`, and an internal TypeScript Adapter on `:7001`. A Python Adapter image can be built with:

```bash
docker compose --profile python-adapter build adapter-python
```

Root commands for all release gates are discoverable in `package.json`; `pnpm verify` becomes the complete RC gate as R2-R9 add their assigned suites.
