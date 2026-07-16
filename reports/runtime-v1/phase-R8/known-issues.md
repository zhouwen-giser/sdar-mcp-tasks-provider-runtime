# Phase R8 Known Issues

- The JSON reference stores are intentionally single-process Adapter stores; resource teams may replace them with their transactional business database while preserving the same taskId/argument/context/command bindings.
- Local Python has no pip and the Docker socket is unavailable, so Python runtime and full PostgreSQL execution are gated in CI.
- R9 folds the machine reports into the final release evidence and adds deployment/upgrade/audit/capacity deliverables.
