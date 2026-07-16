# Phase R4 Test Results

| Command                         | Result     | Evidence                                                                                                                        |
| ------------------------------- | ---------- | ------------------------------------------------------------------------------------------------------------------------------- |
| format/lint/typecheck/build     | PASS       | strict local gates                                                                                                              |
| `pnpm test:unit`                | PASS       | 5 files, 20 tests including Availability contracts                                                                              |
| `pnpm test:contract`            | PASS       | 1 file, 4 tests                                                                                                                 |
| focused real-socket integration | PASS       | 2 files, 2 tests                                                                                                                |
| PostgreSQL R4 integration       | CI pending | batch Availability, unknown fallback, MCP method, sync/task duplicate, conflict, two-Runtime concurrency, restart and Reconcile |

The real PostgreSQL suite is mandatory and runs in GitHub Actions; absence of `TEST_DATABASE_URL` is not skipped locally.
