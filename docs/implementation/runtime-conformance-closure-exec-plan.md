# Runtime Frozen Conformance Closure ExecPlan

Status: H0-H2 committed and pushed; H3-H5 identity and projection implemented

Branch: `fix/frozen-runtime-conformance-closure`

Initial base: `origin/main` at `c5594e4cb59f77421a8aa107defa6054ca61a768`

## Immutable boundaries

- Frozen contract SHA-256: `d33623f33ea2dfbb0ad56868d9911af6c7b37b354a0b17a76798646bded9a845`
- MCP protocol version: `2026-07-28`
- Runtime target version: `2.0.0-rc.1`
- Home Assistant Climate Provider application, deployment, tests, reports, and report generator are zero-diff content.
- The Home Assistant Light Provider branch and PR #12 are out of scope.
- Historical migrations, the frozen contract, Adapter protocol, Provider Ops contract, and Legacy handler are immutable.

## Ordered execution

| Phase       | Deliverable                                                                    | Gate                                              | Status   |
| ----------- | ------------------------------------------------------------------------------ | ------------------------------------------------- | -------- |
| Baseline    | execution-time main identity and upstream merge ledger                         | required ancestor and clean worktree              | complete |
| H0          | R-001 through R-018 regression tests                                           | failures reproduced before implementation changes | complete |
| H1          | durable MRTR response inbox and atomic terminal transitions                    | real PostgreSQL recovery and idempotency tests    | complete |
| H2          | frozen Runtime error mapper                                                    | safe `-32602`/`-32603` classification tests       | complete |
| H3-H5       | transport-scoped typed subscriptions and authoritative notification projection | multi-client identity and strict equality tests   | complete |
| H6-H7       | Runtime poll manager, batched reads, bounded queues, backpressure, metrics     | capacity, SQL-count, and slow-stream tests        | pending  |
| H8          | strengthened conformance and machine reports                                   | 74/74 plus closure suite                          | pending  |
| Publication | final main merge, full gates, phased pushes, Draft PR                          | CI and protected zero-diff checks                 | pending  |

## Verification policy

Each implementation phase runs format, lint, typecheck, build, `git diff --check`, and status before push. Final verification follows the V1.1 task package verbatim and records real, simulated, and unverified evidence separately.
