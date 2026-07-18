# Frozen SDAR MCP Tasks Protocol V1 Migration ExecPlan

Status: blocked at H0 contract intake; branch inventory complete

Branch: `feature/sep2663-frozen-protocol-v1`

Base: `origin/main` at `d55d64649b7a1cd53197ea393e7af0bb07eabfff`

## Immutable baselines

- Frozen contract SHA-256: `d33623f33ea2dfbb0ad56868d9911af6c7b37b354a0b17a76798646bded9a845`
- MCP protocol version: `2026-07-28`
- MCP source commit: `26897cc322f356487da89113451bd16b520b9288`
- MCP schema Git blob: `cc44564e33305dbc07e820cdd0a97648f3852019`
- Evidence binding: `type_only`
- Runtime target version: `2.0.0-rc.1`

The frozen contract is the sole product contract. Upstream `main`, later SDK behavior, and online
documentation are not substitute sources.

## Ordered execution

| Phase               | Deliverable                                                                                             | Gate                                                            | Status                          |
| ------------------- | ------------------------------------------------------------------------------------------------------- | --------------------------------------------------------------- | ------------------------------- |
| A                   | remote branch and PR inventory                                                                          | inventory report matches GitHub and local refs                  | complete                        |
| H0                  | exact frozen contract, pinned MCP schema, derived schemas and protocol lock                             | byte hash, Git blob and lock verification                       | partial: pinned schema verified |
| H1-H3               | isolated SEP-2663 handler, routing, request meta, headers, discovery, tool profile and availability     | focused protocol tests                                          | pending                         |
| H4-H7               | flat task results, detailed task mapping, runtime revision, true TTL, MRTR and cooperative cancellation | PostgreSQL integration and migration upgrade tests              | pending                         |
| H8-H10              | type-only evidence, durable SSE task notifications and non-standard method migration                    | evidence, multi-replica notification and legacy isolation tests | pending                         |
| H11-H13             | Adapter migration, 74-case conformance, CI, version and reports                                         | `verify:v2` and machine reports                                 | pending                         |
| Runtime publication | phased commits, Draft PR, protected CI, normal merge                                                    | merged Runtime PR with green required checks                    | pending                         |
| Provider migration  | merge new `origin/main` into every active Provider branch and update existing PRs                       | Provider conformance and Runtime E2E                            | pending                         |
| Completion audit    | requirement-by-requirement evidence review                                                              | all Definition of Done items proven                             | pending                         |

## Governance invariants

- Do not modify existing migrations, historical release evidence, published tags, or merged branches.
- Do not rebase shared Provider branches or force-push.
- Do not mix Legacy and SEP-2663 shapes in one handler or silently translate Legacy requests.
- Do not use `.skip` or `.only`.
- Do not publish `requirementId` in Provider Evidence.
- Do not modify Provider Wire Contract before the Runtime migration is merged to `main`.
- Do not claim `Interop Certified`; component conformance is the maximum claim in this repository.

## Current blocker

The migration task package was received, but the exact frozen contract document named
`SDAR_MCP_Tasks_Unified_Protocol_Profile_V1.0_FROZEN.md` was not. Its bytes are required before H0
can be implemented without violating the immutable-baseline rule. See
`reports/protocol-v1-migration/branch-inventory.md` for the evidence search and observed hashes.

The independently pinned upstream schema was fetched from the exact source commit and verified as
Git blob `cc44564e33305dbc07e820cdd0a97648f3852019`; its SHA-256 is
`9281c4890630e2d1e61792fa23b4084c4ea360cd58519610cd050545ab7b8708`. This does not replace the
missing SDAR frozen contract or authorize derived SDAR schemas.
