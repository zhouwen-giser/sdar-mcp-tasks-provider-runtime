# Home Assistant Light Provider Delivery Report

Date: 2026-07-19

Branch: `feature/home-assistant-light-provider`

Package: `@sdar/home-assistant-light-provider@0.1.0`

## Delivered

- Standalone Node.js Adapter gRPC application exposing `light_get_state`, `light_set_power`, and
  `light_set_brightness`.
- Allowlisted `light.*` resources with private Home Assistant entity identities.
- Native fetch REST client using only Home Assistant service endpoints for control.
- Authenticated, reconnecting WebSocket `state_changed` subscription with REST polling fallback.
- Durable Task identity, atomic JSON persistence, idempotent `taskId`, side-effect-free reconcile,
  monotonic revisions, terminal non-regression, confirmation timeout, and restart recovery.
- Stable Provider event IDs and a bounded, coalescing, durable telemetry retry queue for resource
  state, brightness metric, health, and Task-bound progress.
- Secret-file-only token loading, plaintext production HTTP guard, Adapter/Telemetry mTLS
  validation, bounded public results, and security regression tests.
- Fake Home Assistant REST/WebSocket service, Provider integration/recovery/security tests, and a
  real Runtime/PostgreSQL/MCP/ProviderTelemetryIngress end-to-end workflow.
- Non-root multi-stage image, optional Compose override, example resource configuration, and
  operator documentation.
- Normal merge of frozen Runtime main, frozen request metadata/headers, flat Task results,
  Ack-first Task notifications, `tasks/get` equality, and actual-state type-only Evidence.

## Verification evidence

| Command or suite                            | Result                                         |
| ------------------------------------------- | ---------------------------------------------- |
| `pnpm test:ha-light`                        | PASS, 4 files / 9 tests                        |
| `pnpm test:ha-light:e2e`                    | PASS, real Runtime and PostgreSQL              |
| `pnpm test:ha-light:protocol-v1`            | PASS, 5 files / 10 tests                       |
| `pnpm protocol:ha-light:check`              | PASS, 8/8 SHA-locked Provider cases            |
| `pnpm audit:dependencies`                   | PASS, no known vulnerabilities                 |
| `pnpm verify:v1.1`                          | PASS, 380.5 seconds                            |
| Unit suite                                  | PASS, 18 files / 75 tests                      |
| Contract suite                              | PASS, 2 files / 6 tests                        |
| Integration suite                           | PASS, 24 files / 192 tests                     |
| Recovery suite                              | PASS, 1 file / 9 tests                         |
| Security suite                              | PASS, 5 files / 30 tests                       |
| SBOM                                        | PASS, 221 production components                |
| Deployment manifests                        | PASS, 10 validated                             |
| Runtime image audit                         | PASS, non-root, 99,880,617 bytes, reproducible |
| Conformance, capacity, rc.1 red regressions | PASS                                           |

The Home Assistant-specific frozen E2E used real Runtime HTTP/SSE and PostgreSQL. Fake Home
Assistant is used for CI; no real lamp or Xiaomi cloud was used or claimed as verification. The
maximum claim is **Home Assistant Light Provider Component Conformant**; this report does not claim
`real-resource qualified` or `Interop Certified`.

## Publication boundary

The frozen Runtime PR #13 merged normally as `7986568`. This branch continues on existing Draft PR
[#12](https://github.com/zhouwen-giser/sdar-mcp-tasks-provider-runtime/pull/12); the new migration
head must be pushed and pass its own protected checks before publication is complete.
