# Phase R9 Test Results

| Command                           | Result     | Evidence                                                     |
| --------------------------------- | ---------- | ------------------------------------------------------------ |
| `pnpm format:check`               | PASS local | all repository files formatted                               |
| `pnpm lint`                       | PASS local | TypeScript and release scripts                               |
| `pnpm typecheck`                  | PASS local | strict project check including E2E/migrator                  |
| `pnpm build` / `pnpm proto:check` | PASS local | release build and generated bindings                         |
| `pnpm audit:dependencies`         | PASS local | no known vulnerabilities after reviewed overrides/upgrades   |
| `pnpm sbom:check`                 | PASS local | 184 production components, lock hash current                 |
| `pnpm deployment:check`           | PASS local | 8 production Kubernetes manifests                            |
| `pnpm test:unit`                  | PASS local | 24 tests                                                     |
| `pnpm test:contract`              | PASS local | 4 tests; initial parallel generation race rerun sequentially |
| `pnpm test:security`              | PASS local | 6 tests                                                      |
| `pnpm verify`                     | pending CI | requires real PostgreSQL and Docker by design                |
| Compose smoke                     | pending CI | image build, Python image and readiness                      |

The local account cannot access Docker and the host Python has no pip; the
release gate intentionally fails rather than skips when those prerequisites or
`TEST_DATABASE_URL` are absent. GitHub Actions is the authoritative complete
environment.
