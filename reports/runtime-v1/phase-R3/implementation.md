# Phase R3 Implementation Report

- Start SHA: `11ed06c34fb84f2d29eb0278cde65d37b807ffa9`
- Upstream main at start and pre-commit fetch: `7e501d07786a7695d205b0bc92b8fdbd667e7f96`
- End SHA: recorded with pushed CI evidence after commit creation

R3 adds the SDK-free Runtime task domain, typed PostgreSQL repository, admission-first Task Engine, and authorized MCP `tasks/get`. Immediate `task_required` and nonterminal `task_capable` calls publish task/current-state/initial-observation/outbox atomically before returning a UUID taskId. Terminal `task_capable` calls remain ordinary Tool results.

Adapter Snapshot revisions update current state under row lock and optimistic CAS. Stale revisions and all changes after a stored terminal are ignored. Business failure/partial completion map to structured MCP completed results; technical failure alone maps to failed.

The integration suite uses a real gRPC Adapter and PostgreSQL. It verifies immediate visibility, completion polling, engine restart, authorization isolation, official MCP create/get, response loss, and an injected post-accept database publication failure.
