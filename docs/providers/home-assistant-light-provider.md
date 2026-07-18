# Home Assistant Light Provider

The Node.js Home Assistant Light Provider connects the SDAR Runtime Adapter gRPC boundary to
Home Assistant REST and WebSocket APIs. Home Assistant, commonly with the Xiaomi Home
integration, remains the source of resource truth and device side effects.

```text
MCP client / Agent -> SDAR Runtime -> Adapter gRPC -> HA REST + WebSocket -> configured light
```

## Prerequisites

Install and configure Home Assistant, add the supported Xiaomi Home integration, and verify each
lamp appears as a `light.*` entity. Compatibility depends on the integration and device exposing
the required Home Assistant light capabilities; this Provider does not directly use Xiaomi
MIoT/miIO and is not a promise of compatibility with every Xiaomi device.

In Home Assistant, open the user profile, create a Long-Lived Access Token, and write it to a
file readable only by the Provider process. Find entity IDs under Developer Tools > States.
Never put the token in `HOME_ASSISTANT_TOKEN` or commit the token file.

## Resource configuration

Copy `apps/home-assistant-light-provider/config/lights.example.json`. `resourceId` is the stable
public identifier; `entityId` stays internal. Only enabled, configured resources can be queried or
controlled. Entity and resource IDs must both be unique, and entities must use the `light` domain.

## Local startup

Set `HOME_ASSISTANT_URL`, `HOME_ASSISTANT_TOKEN_FILE`, `LIGHT_RESOURCES_FILE`, and
`PROVIDER_STATE_PATH`, then run `pnpm dev:ha-light`. The Adapter listens on `0.0.0.0:7010` by
default. Configure Runtime with:

```text
PROVIDER_ID=home-assistant-light
ADAPTER_ENDPOINT=127.0.0.1:7010
PROVIDER_TELEMETRY_INGRESS_ENABLED=true
```

Production rejects plaintext Home Assistant HTTP unless
`HOME_ASSISTANT_ALLOW_INSECURE_HTTP=true` is explicitly set. Adapter and Telemetry TLS modes use
`disabled` or `required`; required mode needs CA, certificate, and key paths.

## Docker

Copy `deploy/home-assistant-light/lights.example.json` to `lights.json`, create the token secret,
set `HOME_ASSISTANT_URL`, and run:

```bash
docker compose -f compose.yaml -f deploy/home-assistant-light/compose.override.yaml up --build
```

The override replaces Runtime's Provider endpoint without changing the default Compose stack.
The image runs as a non-root user and stores durable execution/telemetry state under
`/var/lib/sdar`.

## Operations

- `light_get_state` synchronously returns power, reachability, brightness percent, and observation time.
- `light_set_power` creates a durable Task and confirms `on` or `off` from observed state.
- `light_set_brightness` accepts 1-100, maps it to Home Assistant 1-255, and confirms within one percent.

Control uses only `/api/services/light/turn_on` and `turn_off`; it never writes `/api/states`.
HTTP success is admission of the HA service call, not completion proof. WebSocket
`state_changed` is preferred, while REST polling confirms when WebSocket is unavailable.
Duplicate `taskId` requests replay the persisted execution without repeating a side effect.

## Frozen MCP Tasks V1

Runtime discovery, Tool calls, Task reads, and subscriptions use MCP Stateless `2026-07-28` with
the required frozen Request Meta and routing headers. State reads are `synchronous_only`; power and
brightness controls are `task_required` and return flat Task results. A subscription acknowledges
before emitting complete Task snapshots, and a notification is byte-semantically equal to
`tasks/get` at the same Runtime Revision after transport-only metadata is removed.

Terminal results and Evidence are derived from the persisted Home Assistant observation that
confirmed the change, never from the service-call HTTP 200. Evidence uses only `evidenceType` and
structured-content pointers; the Provider never publishes `requirementId`.

## Telemetry and recovery

Resource state, brightness metric, resource health, and Task-bound execution progress use
Runtime `ProviderTelemetryIngress`. Events enter a bounded durable queue before delivery; retry
keeps the stable Provider event ID and Telemetry failure does not change control results. On
restart, pending and confirming executions are loaded from the atomic JSON state file and safely
reconciled toward the same idempotent desired state.

## Troubleshooting and security

`HOME_ASSISTANT_UNAUTHORIZED` indicates the token file is invalid;
`HOME_ASSISTANT_NOT_FOUND` indicates an absent entity; `BRIGHTNESS_NOT_SUPPORTED` means the
current HA state does not advertise brightness; confirmation timeout means the device never
reached the requested observed state. Check HA connectivity and entity state without copying raw
authorization headers or payloads into logs.

The Provider does not expose entity IDs upstream by default, and logs/errors/results/snapshots/
telemetry omit tokens and raw HA payloads. Cloud behavior, latency, and availability depend on
the Home Assistant integration; local integrations can continue working without vendor cloud
where the integration and device support it.

RGB, color temperature, scenes, effects, flashing, discovery, dynamic groups, pause/resume, and
cancellation after dispatch are outside the first version.
