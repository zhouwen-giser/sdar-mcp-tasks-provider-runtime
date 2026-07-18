# Observability architecture

Runtime v1.1 separates business truth, durable audit delivery, best-effort diagnostics, and metrics.
The telemetry path has no dependency on SDAR Core or ClickHouse and never participates in Task,
command, Outbox, liveness, or readiness decisions.

1. Committed Task and command transitions, accepted Provider ingress facts, and per-Task
   scheduler/recovery/TTL facts become canonical `ProviderOpsEnvelope` records.
2. Audit-class Task, command, and Provider records are inserted into `provider_ops_delivery` in the
   same transaction as their authoritative fact. Replicas claim rows with leases; exporter
   acknowledgement marks delivery, while timeout or collector failure leaves a bounded-backoff
   retry.
3. Diagnostic logs and traces use bounded in-process queues and may drop under pressure. They can
   describe execution but never replace the durable audit contract.
4. Prometheus and OTLP metrics use fixed instruments and bounded label keys and values. Unknown
   values map to `other`; Task, execution, user, correlation, and hash identities are forbidden as
   labels.

Canonical record types are dotted: `provider.task.lifecycle`, `provider.command.lifecycle`,
`provider.scheduler.decision`, `provider.recovery.lifecycle`, and `provider.ttl.lifecycle`.
`recordId` derives from a stable business event key. `recordHash` excludes replica identity and
delivery time, so replay by another replica is identical.

MCP HTTP operations establish W3C server spans. Adapter spans wrap the real gRPC call and propagate
`traceparent`/`tracestate`. Task root context is persisted so scheduler, dispatcher, watchdog, and
recovery work can restore it after restart. Task-bound Provider facts link the Provider span to the
persisted Task trace without allowing the Provider to rewrite Task authority.

Sanitization is an export boundary: credential-like keys and free text, raw arguments/results,
Adapter payloads, unknown Provider fields, raw exception messages, and stacks are removed. Depth,
node, string, and total-byte budgets also cover arrays, maps, sets, and cycles.

Production OTLP requires HTTPS when enabled. Headers and mTLS materials are read from Secret-backed
files and passed only to exporters. Initialization/export failure is warned without secret values,
increments bounded self-monitoring metrics where available, and leaves audit facts retryable. It is
not a readiness dependency.
