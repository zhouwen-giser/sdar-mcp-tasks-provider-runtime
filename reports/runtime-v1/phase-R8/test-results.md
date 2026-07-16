# Phase R8 Test Results

| Command                     | Result     | Evidence                                                               |
| --------------------------- | ---------- | ---------------------------------------------------------------------- |
| format/lint/typecheck/build | PASS       | strict TypeScript and generated Proto gates                            |
| Python syntax               | PASS       | `python3 -m py_compile examples/mock-adapter-python/adapter.py`        |
| TypeScript durable restart  | PASS       | local seed, process replacement, Reconcile FOUND using same state file |
| `pnpm test:conformance`     | pending CI | identical P0-P4 TypeScript/Python HTTP/gRPC/PostgreSQL reports         |
| Compose images              | pending CI | both Adapter images and Runtime readiness                              |

Local Python lacks pip and local Docker is unavailable. The Python dependency/runtime and full PostgreSQL suite therefore run authoritatively in GitHub Actions.
