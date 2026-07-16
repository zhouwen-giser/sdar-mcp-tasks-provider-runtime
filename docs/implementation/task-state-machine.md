# Runtime Task State Machine

The Runtime owns provider task state. Adapter Snapshots report provider facts; they do not contain MCP status.

| Adapter state                                         | Runtime state        | MCP status       | SDAR substate |
| ----------------------------------------------------- | -------------------- | ---------------- | ------------- |
| `ACCEPTED`, `SCHEDULED`                               | `SCHEDULED`          | `working`        | `scheduled`   |
| `QUEUED`                                              | `QUEUED`             | `working`        | `queued`      |
| `RUNNING`                                             | `RUNNING`            | `working`        | `running`     |
| `PAUSED`                                              | `PAUSED`             | `working`        | `paused`      |
| `RESUMING`                                            | `RESUMING`           | `working`        | `resuming`    |
| `STOPPING`                                            | `STOPPING`           | `working`        | `stopping`    |
| `WAITING_INPUT`                                       | `INPUT_REQUIRED`     | `input_required` | none          |
| `SUCCEEDED`, `BUSINESS_FAILED`, `PARTIALLY_COMPLETED` | `TERMINAL_COMPLETED` | `completed`      | none          |
| `TECHNICAL_FAILED`                                    | `TERMINAL_FAILED`    | `failed`         | none          |
| `CANCELLED`                                           | `TERMINAL_CANCELLED` | `cancelled`      | none          |

Repository updates lock the current row, ignore duplicate or stale Adapter revisions, and use a version compare-and-swap. Any stored `TERMINAL_*` state is irreversible. A business failure is a completed provider action whose structured Tool result has `isError=true`; a technical failure is inability to execute or determine that business outcome and therefore maps to MCP `failed`.
