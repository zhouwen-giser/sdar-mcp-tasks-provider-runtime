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

## Provider telemetry ingress

Resource Providers do not need an OTel SDK. Runtime implements the separate batch-unary
`io.sdar.mcp.tasks.telemetry.v1.ProviderTelemetryIngress` gRPC service. It accepts only
`resource.state`, `resource.metric`, `resource.health`, and Task-bound `execution.progress` facts.
This call direction is Provider to Runtime and does not modify `ResourceProviderAdapter`.

For Task-bound events, Runtime verifies Provider, Task, external execution, and operation identity,
then injects the committed Task's operation, execution mode, simulation id, argument hash,
authorization-context hash, Adapter revision, and Observation revision. Resource-only events require
a resource id. Production ingress requires mTLS, and the client certificate common name must match
the Manifest Provider id.

Accepted Provider events are inserted into `provider_ops_delivery` before the RPC acknowledges
them. `(providerId, providerEventId)` is idempotent across replicas: identical retries return the
same record id with `duplicate=true`; changed content is rejected with
`PROVIDER_EVENT_ID_CONFLICT`. Batch, event-byte, JSON-depth/node, key/id, timestamp-skew, and rate
limits are enforced before persistence.

## Stable event contract

`ProviderOpsEnvelope` is the product contract; OTel logs are only its transport. `recordId` is a
deterministic UUIDv5 over stable event identity. `recordHash` is SHA-256 over RFC 8785 canonical
JSON and excludes delivery-time metadata. Task lifecycle audit records come from committed
transition/Outbox facts, never from API-handler intent. A rollback emits no lifecycle record.

| Record or span                | Source                                 | Coverage                                                                |
| ----------------------------- | -------------------------------------- | ----------------------------------------------------------------------- |
| `provider.task.lifecycle`     | committed Task transition Outbox facts | queued/running/waiting/paused/resuming/stopping/terminal/expired        |
| `provider.command.lifecycle`  | Durable Command Dispatcher facts       | created/claimed/retry/ack/reject/exhaust/supersede                      |
| `adapter.rpc`                 | real gRPC Adapter boundary             | method, provider, safe identities, duration, status; never RPC payloads |
| `provider.scheduler.decision` | Durable Scheduler results              | scheduled/claimed/started/retry/deadline/start-window miss              |
| `provider.recovery.lifecycle` | Recovery Manager results               | per-Task reconcile success/failure                                      |
| `provider.ttl.lifecycle`      | TTL Cleaner committed results          | per-Task expire/purge/blocked                                           |

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

## Trace propagation

Runtime creates `mcp.tools.call`, `mcp.tasks.get`, `mcp.tasks.cancel`, `mcp.tasks.update`,
`mcp.tasks.pause`, and `mcp.tasks.resume` server spans. Valid W3C `traceparent`/`tracestate` HTTP
headers become the parent; otherwise Runtime starts a new root. Adapter client spans wrap the real
gRPC call and inject W3C context into gRPC metadata before invocation. They never include request or
response payloads or raw exceptions.

Migration 018 stores the Task trace id, Runtime root `traceparent`/`tracestate`, and correlation id on
both admission intent and Task. Scheduler, command dispatcher, watchdog, and recovery Adapter calls
restore that parent after restart. Task-bound Provider events carry the Provider span identity when
valid and include the persisted Task trace id as a link attribute.

## Privacy and failure behavior

The sanitizer recursively removes passwords, secrets, API keys, cookies, tokens,
authorization/JWT material, raw arguments, input/answer values, and Adapter payloads before
export. It applies depth, node, per-string, and total-byte budgets to objects, arrays, maps, and
sets; cycles and exceeded limits become stable redaction/truncation markers. `argumentHash`,
`authorizationContextHash`, `simulationId`, and `executionMode` are allowed where the event
contract requires them. Adapter spans never contain request or response bodies.

Provider event payloads use event-specific allowlists. `resource.state` accepts `state`,
`reasonCode`, and bounded `attributes`; `resource.metric` accepts `metricName`, `value`, `unit`, and
`quality`; `resource.health` accepts `health` and `reasonCode`; `execution.progress` accepts
`current`, `total`, `percentage`, and `unit`. Unknown payload fields are dropped before durable
persistence.

Diagnostic processors use bounded queues, batches, and export timeouts. Audit facts use the durable
delivery table, lease-safe claims, bounded backoff, and exporter acknowledgement before marking a
record delivered. Collector outage never changes business processing or readiness; audit records
remain retryable. On shutdown, Runtime stops both publisher loops, force-flushes telemetry providers,
and closes the Provider ingress server.

No telemetry development stack is shipped in v1.1. CI uses in-memory, timeout, and queue-pressure
exporters, keeping the default Compose stack and production image free of Collector/ClickHouse
dependencies.
