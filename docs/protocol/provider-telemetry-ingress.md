# Provider Telemetry Ingress protocol

`io.sdar.mcp.tasks.telemetry.v1.ProviderTelemetryIngress` is a Runtime-hosted gRPC service for
Resource Provider facts. It is independent from `ResourceProviderAdapter`: Adapter RPC flows from
Runtime to Provider, while telemetry ingress flows from Provider to Runtime. Providers need only a
gRPC/Protobuf client and do not need an OpenTelemetry SDK.

## Connection and identity

Enable the listener with `PROVIDER_TELEMETRY_INGRESS_ENABLED=true`. Development may use plaintext;
production requires `PROVIDER_TELEMETRY_TLS_MODE=required` and complete server CA, certificate, and
key files. Runtime authenticates the client certificate common name and requires it, the request
`provider_id`, configured Provider id, and startup Manifest Provider id to match.

`EmitProviderEvents` accepts a bounded batch. Each event supplies a Provider-unique, retry-stable
`provider_event_id`, monotonic diagnostic sequence, event type, authoritative occurrence time, and
the identities applicable to its class. Runtime acknowledges only after the accepted fact is in
durable Provider Ops delivery.

## Event classes

| Event                | Binding       | Required fields                                  | Allowed payload                                  |
| -------------------- | ------------- | ------------------------------------------------ | ------------------------------------------------ |
| `resource.state`     | Resource-only | `resource_id`, `resource_type`                   | `state`, `reasonCode`, bounded `attributes`      |
| `resource.metric`    | Resource-only | `resource_id`, `resource_type`                   | `metricName`, numeric `value`, `unit`, `quality` |
| `resource.health`    | Resource-only | `resource_id`, `resource_type`                   | `health`, `reasonCode`                           |
| `execution.progress` | Task-bound    | `task_id`, `external_execution_id`, operation id | `current`, `total`, `percentage`, `unit`         |

Task-bound events are joined to the committed Task. Runtime rejects missing Tasks and execution,
operation, or Provider identity mismatches, then injects authoritative argument/authorization
hashes, execution mode, simulation id, revisions, and persisted Task trace identity. Providers
cannot override those fields. Resource-only facts require no Task, but `execution.progress` can
never be resource-only.

## Idempotency and retries

The database uniquely keys `(provider_id, provider_event_id)`. Repeating identical content returns
the original record id with `duplicate=true` and emits no second Provider Ops record. Reusing the id
for changed content returns `PROVIDER_EVENT_ID_CONFLICT`. Clients may therefore retry an uncertain
unary call without inventing a new id. The TypeScript and Python mock Adapters contain resource,
Task-bound, and duplicate-retry examples.

Batch size, encoded event bytes, JSON depth/node counts, key/id length, timestamp skew, and
per-replica rate are bounded before persistence. Event names and payload fields are allowlisted;
unknown event types are rejected and unknown payload fields are discarded.
