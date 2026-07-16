# Phase R6 Test Results

| Command                        | Result     | Evidence                                                                      |
| ------------------------------ | ---------- | ----------------------------------------------------------------------------- |
| format/lint/typecheck/build    | PASS       | strict local gates                                                            |
| `pnpm test:unit`               | PASS       | 6 files, 22 tests                                                             |
| PostgreSQL control integration | pending CI | stable/multi-round input, cancel race, deadline race, pause/resume and outbox |
| Official MCP task controls     | pending CI | result, update and cancel through SDK client                                  |
| Compose smoke                  | pending CI | Runtime readiness and both Adapter images                                     |

Local Docker/PostgreSQL cannot run because this environment cannot access the Docker socket. GitHub Actions remains the authoritative database and Compose gate.
