# Phase R7 Test Results

| Command                     | Result     | Evidence                                                                              |
| --------------------------- | ---------- | ------------------------------------------------------------------------------------- |
| format/lint/typecheck/build | PASS       | strict local gates                                                                    |
| `pnpm test:unit`            | PASS       | 6 files, 24 tests including config/body limits/readiness                              |
| `pnpm test:security`        | PASS       | 2 files, 6 tests: JWT/trusted identity, JSON limits, redaction, metrics               |
| `pnpm test:recovery`        | pending CI | response loss, command replay, Adapter restart, DB fault, readiness/auth/rate/metrics |
| Compose smoke               | pending CI | Runtime startup recovery/readiness and images                                         |

Local Docker/PostgreSQL is unavailable because this environment cannot access the Docker socket. GitHub Actions is the authoritative recovery and Compose gate.
