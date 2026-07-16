export type ExecutionMode = "live" | "simulation" | "historical-replay";
export type McpTaskStatus = "working" | "input_required" | "completed" | "failed" | "cancelled";
export type InternalTaskState =
  | "SCHEDULED"
  | "STARTING"
  | "QUEUED"
  | "RUNNING"
  | "PAUSED"
  | "RESUMING"
  | "INPUT_REQUIRED"
  | "STOPPING"
  | "TERMINAL_COMPLETED"
  | "TERMINAL_FAILED"
  | "TERMINAL_CANCELLED";

export interface AuthorizationContext {
  hash: string;
  executionMode: ExecutionMode;
  simulationId: string | null;
  correlationId?: string;
}

export interface TaskRecord {
  taskId: string;
  providerId: string;
  operationName: string;
  operationSnapshotId: string;
  authorizationContextHash: string;
  executionMode: ExecutionMode;
  simulationId: string | null;
  arguments: Record<string, unknown>;
  argumentHash: string;
  externalExecutionId: string | null;
  internalState: InternalTaskState;
  mcpStatus: McpTaskStatus;
  substate: string | null;
  statusMessage: string | null;
  result: Record<string, unknown> | null;
  error: Record<string, unknown> | null;
  adapterRevision: number;
  ttlMs: number | null;
  pollIntervalMs: number;
  createdAt: Date;
  updatedAt: Date;
  version: number;
  acceptedAt: Date;
  notBefore: Date | null;
  latestStartAt: Date | null;
  deadlineAt: Date | null;
  cancelRequested: boolean;
  stopReason: string | null;
  timing: Record<string, unknown>;
  recoveryAttempts: number;
  lastReconciledAt: Date | null;
}

export interface SnapshotTransition {
  internalState: InternalTaskState;
  mcpStatus: McpTaskStatus;
  substate: string | null;
  statusMessage: string;
  result: Record<string, unknown> | null;
  error: Record<string, unknown> | null;
  terminal: boolean;
  observationType: string;
}

export interface AdapterSnapshotLike {
  state: string;
  reasonCode: string;
  message: string;
  retryable: boolean;
  result?: Record<string, unknown>;
}

function businessResult(
  snapshot: AdapterSnapshotLike,
  outcome: "success" | "business_failure" | "partial_completion",
  isError: boolean,
): Record<string, unknown> {
  return {
    content: [{ type: "text", text: snapshot.message || outcome }],
    isError,
    structuredContent: {
      outcome,
      reasonCode: snapshot.reasonCode || outcome.toUpperCase(),
      retryable: snapshot.retryable,
      completedAt: new Date().toISOString(),
      ...(snapshot.result ?? {}),
    },
  };
}

export function mapAdapterSnapshot(snapshot: AdapterSnapshotLike): SnapshotTransition {
  switch (snapshot.state) {
    case "ACCEPTED":
    case "SCHEDULED":
      return working("SCHEDULED", "scheduled", snapshot, "task.accepted");
    case "QUEUED":
      return working("QUEUED", "queued", snapshot, "task.accepted");
    case "RUNNING":
      return working("RUNNING", "running", snapshot, "task.started");
    case "PAUSED":
      return working("PAUSED", "paused", snapshot, "task.paused");
    case "RESUMING":
      return working("RESUMING", "resuming", snapshot, "task.resumed");
    case "STOPPING":
      return working("STOPPING", "stopping", snapshot, "task.progress");
    case "WAITING_INPUT":
      return {
        internalState: "INPUT_REQUIRED",
        mcpStatus: "input_required",
        substate: null,
        statusMessage: snapshot.message,
        result: null,
        error: null,
        terminal: false,
        observationType: "task.progress",
      };
    case "SUCCEEDED":
      return terminal(
        "TERMINAL_COMPLETED",
        "completed",
        businessResult(snapshot, "success", false),
        null,
        snapshot,
      );
    case "BUSINESS_FAILED":
      return terminal(
        "TERMINAL_COMPLETED",
        "completed",
        businessResult(snapshot, "business_failure", true),
        null,
        snapshot,
      );
    case "PARTIALLY_COMPLETED":
      return terminal(
        "TERMINAL_COMPLETED",
        "completed",
        businessResult(snapshot, "partial_completion", true),
        null,
        snapshot,
      );
    case "CANCELLED":
      return terminal("TERMINAL_CANCELLED", "cancelled", null, null, snapshot);
    case "TECHNICAL_FAILED":
      return terminal(
        "TERMINAL_FAILED",
        "failed",
        null,
        { code: -32603, message: snapshot.message },
        snapshot,
      );
    default:
      throw new Error(`UNKNOWN_ADAPTER_STATE:${snapshot.state}`);
  }
}

function working(
  internalState: InternalTaskState,
  substate: string,
  snapshot: AdapterSnapshotLike,
  observationType: string,
): SnapshotTransition {
  return {
    internalState,
    mcpStatus: "working",
    substate,
    statusMessage: snapshot.message,
    result: null,
    error: null,
    terminal: false,
    observationType,
  };
}

function terminal(
  internalState: InternalTaskState,
  mcpStatus: McpTaskStatus,
  result: Record<string, unknown> | null,
  error: Record<string, unknown> | null,
  snapshot: AdapterSnapshotLike,
): SnapshotTransition {
  return {
    internalState,
    mcpStatus,
    substate: null,
    statusMessage: snapshot.message,
    result,
    error,
    terminal: true,
    observationType: "task.progress",
  };
}

export function isTerminalState(state: InternalTaskState): boolean {
  return state.startsWith("TERMINAL_");
}
