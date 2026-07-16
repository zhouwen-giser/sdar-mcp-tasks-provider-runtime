# Runtime v1.0.0-rc.2 Hardening Execution Plan

Status: active  
Branch: `feature/mcp-tasks-provider-runtime-v1`  
Immutable baseline: annotated tag `v1.0.0-rc.1` -> `51d68926ba1bc9e935438e750582693aea3ecf4d`  
Target: annotated tag `v1.0.0-rc.2`  
Last updated: 2026-07-16 (H3 closure)

## Objective and invariants

Close rc.1 findings F-001 through F-019 with executable migrations, PostgreSQL-backed
state machines, protocol validation and black-box regression evidence. A request or Adapter
Ack is never treated as safe-stop proof. Runtime observation revision is independent from
Adapter revision. Historical Tasks always use their immutable Operation Snapshot. No slow
Adapter RPC may run while a database client, transaction or advisory transaction lock is held.

The rc.1 tag is immutable. Work stays on the target feature branch; no force push, history
rewrite, direct `main` commit, skipped test, weakened assertion, mock-only completion claim or
post-tag patch is allowed.

## Authority order

1. Packaged `SDAR_MCP_Tasks_Provider_Profile_V1.0.md`.
2. Packaged Runtime Design DOCX.
3. Packaged Adapter Design DOCX.
4. Frozen rc.1 review findings and rc.2 task-package decisions.
5. Current Adapter Protocol, database compatibility and locked MCP SDK wire schema.
6. Repository conventions.

The task package was verified against all 13 entries in `SHA256SUMS.txt` before use. The two
packaged DOCX files are byte-identical to the repository reference copies.

## Phase protocol

Every H phase follows this loop:

1. fetch tags/prune; compare `origin/main`, the target remote branch and the actual local Head;
2. merge real upstream changes without rewriting pushed history;
3. update this plan, traceability and phase sync evidence;
4. add a failing reproducer before implementation, then implement code/migrations;
5. run required new and old tests without skip/TODO fallbacks;
6. write `reports/runtime-v1-rc2/phase-HN/` evidence and residual risks;
7. create one phase-scoped commit, push, inspect branch and PR checks, and repair failures;
8. advance only when the phase exit criteria are satisfied.

## Progress and exit evidence

| Phase | Scope                                                                         | Required evidence                                             | Status            |
| ----- | ----------------------------------------------------------------------------- | ------------------------------------------------------------- | ----------------- |
| H0    | real baseline, six red regressions, plan and matrix                           | baseline assessment, red output, H0 report, push/CI           | complete          |
| H1    | durable stop command dispatcher and rejection policy                          | T-001..T-006, T-029, T-030; migration; no RPC under DB client | complete          |
| H2    | immediate watchdog, late response compensation, scheduled retry               | T-007..T-013; multi-instance/response-loss evidence           | complete          |
| H3    | unified transition, Runtime observation revision and Outbox                   | T-014..T-016 plus lifecycle/control regressions               | CI repair pending |
| H4    | immutable Snapshot resolution and Adapter identity validation                 | T-017..T-022; Manifest v1->v2 recovery                        | pending           |
| H5    | TTL expiry/purge and degraded reliable reads                                  | T-023..T-028; multi-instance cleaner                          | pending           |
| H6    | typed MCP errors, result schema and ttl/poll compatibility                    | T-031..T-040 over real MCP wire                               | pending           |
| H7    | health, bounded rate limit, idempotency pool, image and HTTP mode             | T-041..T-046; capacity and image proof                        | pending           |
| H8    | rc.1 forward migration, recovery ordering, expanded dual-language conformance | T-047..T-049 and T-001..T-046 regression                      | pending           |
| H9    | docs, full release gate, PR #1, final report and immutable tag                | T-050, all checks green, report-containing tag commit         | pending           |

## Planned schema evolution

Published migrations 001-006 remain byte-for-byte unchanged. Append-only rc.2 migrations will
cover durable command claim/retry state, independent observation revision, start attempts and
watchdog anchors, task handle expiry/retention, idempotency leases and supporting indexes. H8
will build a real rc.1 fixture at migration 006 and forward-upgrade it.

## Verification strategy

`test:rc2:red` records H0 expected failures separately from normal green CI. From H1 onward its
guards are turned green and replaced/supplemented by real PostgreSQL, gRPC and MCP wire tests.
H9 adds `verify:rc2`, aggregating existing gates, T-001..T-050, Buf compatibility, Compose,
dual-language conformance, upgrade and expanded capacity evidence.

Local environment facts are evidence, not exceptions: Windows CRLF checkout required portable
Prettier handling; the installed grpc-tools native binaries currently fail before execution;
the Windows `python3` app alias is not a usable interpreter. GitHub Actions remains mandatory
for Linux/PostgreSQL/Docker/Python evidence, but local failures must still be fixed or accurately
reported rather than hidden.

## Release protocol

H9 updates PR #1 title/body with F-001..F-019 closure and exact checks. Only after the final
report is committed, both push and PR workflows succeed, the worktree is clean, and rc.1 is
re-verified unchanged may an annotated non-overwriting `v1.0.0-rc.2` tag be created and pushed.
The tag is never moved.

## Decision log

- 2026-07-16 H0: actual local/remote/PR Head equals rc.1 commit `51d6892`; `origin/main` is the
  merge base and the feature branch is 25 commits ahead, 0 behind.
- 2026-07-16 H0: preserve the supplied hardening package byte-for-byte and exclude it from
  Prettier so its verified checksums remain meaningful.
- 2026-07-16 H0: separate expected-red regressions from normal CI until their owning phases
  implement the fixes; an expected red result is never reported as a passing release gate.
- 2026-07-16 H0 closure: commits `4bb2820` and `facc38e`; push run `29508056591` and
  PR run `29508060466` passed quality, Buf and Compose jobs.
- 2026-07-16 H1: command claim and finalization use separate short database transactions;
  Adapter RPC runs between them without a checked-out database connection. User cancellation
  rejection restores only an authoritative Reconcile Snapshot, while mandatory stop rejection
  fails with `SAFE_STOP_UNCONFIRMED`.
- 2026-07-16 H1 closure: implementation `3f2d425`; push run `29509615239` and PR run
  `29509616607` passed `pnpm verify`, Buf lint/compatibility and Compose with both Adapter
  images. The report closure commit follows the evidence it records.
- 2026-07-16 H2: persist start attempts and retry anchors; never retry an uncertain Start before
  Reconcile `NOT_FOUND`; late/queued immediate execution enters durable safe-stop compensation.
- 2026-07-16 H2 upstream event: PR #1 was externally merged while H2 was in progress, and
  governance commit `075d8dc` reached both `main` and the target branch. H2 implementation
  `20d4598` was committed first, then remote target `e768f52` was merged without conflict as
  `a14d4b3`. Draft PR #3 now carries the remaining H2-H9 delta so PR-context checks continue.
- 2026-07-16 H2 closure: push run `29511568781`, PR runtime run `29511591880`, and
  governance quality/Compose runs `29511590472`/`29511590473` all succeeded.
- 2026-07-16 H3: introduced a Runtime-owned observation sequence and one transactional
  transition primitive for Task state, complete observations and stable-key outbox events.
  PostgreSQL fault injection proves that an outbox insertion failure rolls back Task and
  observation changes. Implementation `f3ad038`; push runtime `29514013921`, PR runtime
  `29514017780`, quality `29514019017` and Compose `29514017491` all succeeded.
