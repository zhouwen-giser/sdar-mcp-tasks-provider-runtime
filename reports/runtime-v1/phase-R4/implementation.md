# Phase R4 Implementation Report

- Start SHA: `0fe3bcfecacfb2e3866bdd48b4fc6f37b60c993f`
- Upstream main at start/pre-commit fetch: `7e501d07786a7695d205b0bc92b8fdbd667e7f96`
- End SHA: recorded with pushed CI evidence after commit creation

R4 implements the Profile Availability method over MCP and batched gRPC, including four-state normalization, request identity, validity/window validation, required restricted metadata, trusted execution context, and explicit unknown fallback on Adapter transport failure. Availability never writes task/admission/idempotency state.

Durable idempotency uses a deep canonical SHA-256 argument hash and a PostgreSQL session advisory lock keyed by authorization, operation, idempotency key, execution mode, and simulation. The first caller records a stable taskId before the Adapter call. Concurrent processes serialize on the database lock; completed duplicates return the stored synchronous result or original taskId. Parameter drift returns a conflict.

If a process loses StartOperation response or exits before publication, the pending record retains its stable taskId. The next caller holds the same distributed lock, checks for an already published task, calls side-effect-free Reconcile, and publishes the recovered execution or safely retries the same taskId only after `NOT_FOUND`.
