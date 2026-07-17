# Provider Ops Telemetry

Runtime v1.1 exports Provider operational telemetry over OTLP/HTTP while retaining the existing
Prometheus `/metrics` endpoint. Telemetry is optional and never participates in health,
readiness, Task state, command dispatch, safe stop, recovery, or Outbox delivery decisions.

## Boundary and configuration

Runtime sends traces, logs/events, and metrics only to the configured OTLP endpoint. It has no
ClickHouse or SDAR Core client and does not query either system. Enable export with
`OTEL_ENABLED=true`; set `OTEL_EXPORTER_OTLP_ENDPOINT` to the collector base URL and optionally
set a stable replica-specific `OTEL_SERVICE_INSTANCE_ID`. The exporter appends `/v1/traces`,
`/v1/logs`, and `/v1/metrics`.

Every signal carries the OTel resource attributes `service.name`, `service.version`,
`service.instance.id`, `deployment.environment`, `sdar.provider.id`, and
`sdar.provider.version`. Each Runtime replica must use a different instance id.

## Stable event contract

`ProviderOpsEnvelope` is the product contract; OTel logs are only its transport. `recordId` is a
deterministic UUIDv5 over stable event identity. `recordHash` is SHA-256 over RFC 8785 canonical
JSON and excludes delivery-time metadata. Task lifecycle audit records come from committed
transition/Outbox facts, never from API-handler intent. A rollback emits no lifecycle record.

| Record or span                | Source                                 | Coverage                                                                |
| ----------------------------- | -------------------------------------- | ----------------------------------------------------------------------- |
| `provider.task_lifecycle`     | committed Task transition Outbox facts | queued/running/waiting/paused/resuming/stopping/terminal/expired        |
| `provider.command_dispatch`   | Durable Command Dispatcher facts       | created/claimed/retry/ack/reject/exhaust/supersede                      |
| `adapter.rpc`                 | real gRPC Adapter boundary             | method, provider, safe identities, duration, status; never RPC payloads |
| `provider.scheduler_decision` | Durable Scheduler results              | scheduled/claimed/started/retry/deadline/start-window miss              |
| `provider.recovery_event`     | Recovery Manager results               | reconcile start/success/failure and lease conflict                      |
| `provider.ttl_event`          | TTL Cleaner committed results          | renew/expire/purge/blocked                                              |

Lifecycle payloads include previous/current state and substate, reason, Observation and Adapter
revisions, terminal flag, and result class. Command payloads include command type/sequence,
previous/current durable command state, attempt, retry delay, reason, and Adapter RPC status.

## Metrics

Prometheus compatibility is unchanged. OTel counters are `provider_task_transition_total`,
`provider_command_total`, `adapter_rpc_total`, `provider_error_total`, and
`provider_recovery_total`. Histograms are `adapter_rpc_duration`, `command_dispatch_duration`,
`task_transition_duration`, and `recovery_duration`. Gauges are `active_tasks`,
`pending_commands`, `outbox_pending`, and `recovery_backlog`.

Metric labels are allowlisted and bounded. Task ids, execution ids, correlation ids, user ids,
argument hashes, and authorization hashes are never metric labels.

## Privacy and failure behavior

The sanitizer recursively removes passwords, tokens, authorization/JWT material, raw arguments,
input/answer values, and Adapter payloads before export. `argumentHash`,
`authorizationContextHash`, `simulationId`, and `executionMode` are allowed where the event
contract requires them. Adapter spans never contain request or response bodies.

Batch processors use bounded queues, bounded batches, export timeouts, and drop-on-saturation
behavior. Collector outage, timeout, queue overflow, serialization failure, and shutdown failure
are best effort: Runtime continues business processing and readiness is unchanged. On shutdown,
Runtime force-flushes and then shuts down all telemetry providers with settled-result handling.

No telemetry development stack is shipped in v1.1. CI uses in-memory, timeout, and queue-pressure
exporters, keeping the default Compose stack and production image free of Collector/ClickHouse
dependencies.
