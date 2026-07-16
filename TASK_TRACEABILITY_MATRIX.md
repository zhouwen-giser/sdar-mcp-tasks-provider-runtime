# Runtime V1.0 需求追踪入口

Phase R0 已完成真实仓库核验。持续维护的详细矩阵位于
[`docs/implementation/requirement-traceability.md`](docs/implementation/requirement-traceability.md)。
下表保留为根目录索引；状态以详细矩阵和各 Phase 报告为准。

| Requirement | 设计依据 | Phase | 预期实现位置 | 必须测试 | 状态 |
|---|---|---|---|---|---|
| RQ-MCP | Profile 5-8、33 | R2-R6 | `packages/mcp-protocol`, `apps/runtime` | contract/e2e | PLANNED |
| RQ-REG | Runtime 4 | R2 | `packages/operation-registry` | unit/integration/security | PLANNED |
| RQ-ADAPTER | Adapter 4-15 | R1-R8 | `proto`, `packages/adapter-protocol` | proto/contract/cross-language | PLANNED |
| RQ-STATE | Profile 5、17、24；Runtime 5 | R3-R6 | `packages/domain`, `packages/task-engine` | state matrix/terminal CAS | IN PROGRESS (R3 CORE) |
| RQ-ADMISSION | Runtime 6、8、10 | R3-R4 | task engine/PostgreSQL repositories | PG/gRPC crash-window/recovery | IN PROGRESS (R3 CORE) |
| RQ-AVAIL | Profile 8-11 | R4 | domain/task engine/MCP/gRPC | four-state/window/unknown E2E | IN PROGRESS (IMPLEMENTED) |
| RQ-TIME | Profile 12-15 | R5 | domain/scheduler/task engine | fake-clock/restart | PLANNED |
| RQ-CANCEL | Profile 23、36 | R6-R7 | task control/Adapter gateway | safe-stop/race | PLANNED |
| RQ-INPUT | Profile 22 | R6 | task engine/PostgreSQL repositories | update/idempotency | PLANNED |
| RQ-IDEMP | Profile 29 | R3-R5 | advisory-lock persistence/domain | duplicate/concurrent/reconcile | IN PROGRESS (R4 IMMEDIATE) |
| RQ-OBS | Profile 17-18、32 | R6 | observation/outbox repositories | revision/delivery | PLANNED |
| RQ-RECOVERY | Profile 30 | R3-R7 | recovery manager | restart/fault | PLANNED |
| RQ-PERSIST | Runtime 8 | R2-R7 | `migrations`, PostgreSQL package | migration/integration | PLANNED |
| RQ-SEC | Profile 20、34-35 | R2、R7 | security and protocol boundaries | auth/mode/fuzz | PLANNED |
| RQ-OBSERVABILITY | Runtime 12 | R1、R7-R9 | `packages/observability` | metrics/log redaction | PLANNED |
| RQ-CONFORMANCE | Profile 37-39 | R8-R9 | `packages/conformance-testkit` | P0-P4/cross-language | PLANNED |
