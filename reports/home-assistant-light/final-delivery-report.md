# Home Assistant Light Provider Delivery Report

Date: 2026-07-18

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

## Verification evidence

| Command or suite                            | Result                                         |
| ------------------------------------------- | ---------------------------------------------- |
| `pnpm test:ha-light`                        | PASS, 4 files / 9 tests                        |
| `pnpm test:ha-light:e2e`                    | PASS, real Runtime and PostgreSQL              |
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

The Home Assistant-specific E2E used an isolated `sdar_ha_light_test` database on the existing
local PostgreSQL test container. Fake Home Assistant is used for CI; no real lamp or Xiaomi cloud
was used or claimed as verification.

## Publication boundary

Local implementation and all repository gates are complete. Branch push, Draft PR creation, and
protected GitHub `runtime-ci`/Compose results are publication evidence and are recorded only after
the corresponding remote objects exist.
