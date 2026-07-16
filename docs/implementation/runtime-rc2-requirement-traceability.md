# Runtime rc.2 Requirement Traceability

Status values are `RED_BASELINE`, `IN_PROGRESS`, `PASS`, `N/A_WITH_NORMATIVE_BASIS` or `OPEN`.
No item becomes PASS without executed evidence and a phase commit/CI reference.

| Requirement        | Finding           | Phase | Implementation evidence                                                       | Test evidence                                          | Commit / CI                                 | Status       |
| ------------------ | ----------------- | ----- | ----------------------------------------------------------------------------- | ------------------------------------------------------ | ------------------------------------------- | ------------ |
| RC2-CONTROL-01     | F-001/F-009       | H1    | migration 007; durable dispatcher; ADR-004; short claim/finalize transactions | PostgreSQL T-001..T-006,T-029,T-030; 25/25 integration | `3f2d425`; runs `29509615239`,`29509616607` | PASS         |
| RC2-TIME-01        | F-002             | H2    | migration 008; immediate watchdog; late-response durable stop; ADR-005        | PostgreSQL/gRPC T-007..T-009; structural guard green   | `20d4598`; runs `29511568781`,`29511591880` | PASS         |
| RC2-TIME-02        | F-003             | H2    | persisted attempts/backoff; claim-owner CAS; Reconcile-before-retry           | PostgreSQL scheduler/concurrency T-010..T-013          | `20d4598`; runs `29511568781`,`29511591880` | PASS         |
| RC2-OBS-01         | F-004             | H3    | migration 009; unified transition primitive; stable terminal/outbox contract  | PostgreSQL T-014..T-016; 34/34 lifecycle integration   | `f3ad038`,`b599480`; run `29514590381`      | PASS         |
| RC2-SNAPSHOT-01    | F-005             | H4    | immutable snapshot repository; Engine/Scheduler/Recovery snapshot resolution  | PostgreSQL T-017,T-018; rc.2 guard green               | implementation complete; CI pending         | IN_PROGRESS  |
| RC2-IDENTITY-01    | F-006             | H4    | full Snapshot/Ack identity validator; conflict audit/metric; unique binding   | PostgreSQL/gRPC T-019..T-022; rc.2 guard green         | implementation complete; CI pending         | IN_PROGRESS  |
| RC2-TTL-01         | F-007             | H5    | `ttl_ms` stored only                                                          | T-023..T-026                                           | pending                                     | OPEN         |
| RC2-READ-01        | F-008             | H5    | tasks/get currently propagates Adapter transient error                        | T-027,T-028                                            | pending                                     | OPEN         |
| RC2-WIRE-01        | F-010/F-011/F-012 | H6    | generic Error at MCP boundary; output validator not retained/applied          | T-031..T-039                                           | pending                                     | OPEN         |
| RC2-COMPAT-01      | F-013             | H6    | top-level SDK fields and SDAR aliases not frozen in ADR                       | T-040                                                  | pending                                     | OPEN         |
| RC2-OPS-01         | F-014/F-015       | H7    | startup-centric health and unbounded local rate state require hardening       | T-041..T-043                                           | pending                                     | OPEN         |
| RC2-DB-01          | F-016             | H7    | advisory transaction/recovery and idempotency paths can span RPC              | T-044                                                  | pending                                     | RED_BASELINE |
| RC2-IMAGE-01       | F-017             | H7    | rc.1 image baseline requires reproducible production audit                    | T-045                                                  | pending                                     | OPEN         |
| RC2-MCP-01         | F-018             | H7    | per-request Server/Transport requires explicit stateless contract             | T-046                                                  | pending                                     | OPEN         |
| RC2-MIGRATION-01   | all schema        | H8    | published 001-006 frozen; rc.2 append-only migrations pending                 | T-047                                                  | pending                                     | OPEN         |
| RC2-CONFORMANCE-01 | F-019             | H8    | rc.1 reports contain only 10 scenarios/language                               | T-048,T-049                                            | pending                                     | OPEN         |
| RC2-RELEASE-01     | all               | H9    | final report/PR/tag pending                                                   | T-050                                                  | pending                                     | OPEN         |

## Test inventory

The authoritative scenario definitions are the task package's T-001 through T-050 matrix.
H0 added six expected-red guards for T-007, T-010, T-014, T-017, T-019/T-021 and T-029.
Each owning phase must add the matrix's required real layer; structural guards alone cannot
satisfy final compliance.

## Baseline identities

- rc.1 annotated tag object: `9a4715e6316a23f399ee06eea2444b0245fa1adb`
- rc.1 peeled commit/local/remote branch/PR Head: `51d68926ba1bc9e935438e750582693aea3ecf4d`
- `origin/main`: `7e501d07786a7695d205b0bc92b8fdbd667e7f96`
- PR #1 baseline checks: push and PR `quality`/`compose-smoke` SUCCESS; runs
  `29502133316` and `29502131960`.
