export const ADAPTER_PROTOCOL_VERSION = "1.0";

export interface RequestMetadata {
  adapterProtocolVersion: string;
  providerId: string;
  correlationId: string;
}

export interface OperationCapabilities {
  availability: boolean;
  scheduling: boolean;
  maxElapsed: boolean;
  cancel: boolean;
  pauseResume: boolean;
  inputRequired: boolean;
  idempotency: boolean;
  observations: boolean;
}

export type OperationExecution = "SYNCHRONOUS" | "TASK_CAPABLE" | "TASK_REQUIRED";

export interface OperationDefinition {
  name: string;
  description: string;
  execution: OperationExecution;
  inputSchema: unknown;
  outputSchema: unknown;
  capabilities: OperationCapabilities;
  resourceBinding?: {
    mode: "NONE" | "ARGUMENT_REFERENCE";
    resourceIdJsonPointer?: string;
  };
}

export interface ProviderManifest {
  adapterProtocolVersion: string;
  providerId: string;
  providerType: string;
  providerVersion: string;
  inventoryMode: "RUNTIME_VISIBLE" | "OPAQUE";
  operations: OperationDefinition[];
}

export interface ExecutionSnapshot {
  taskId: string;
  externalExecutionId: string;
  state: string;
  revision: string | number;
  reasonCode: string;
  message: string;
  retryable: boolean;
  observedAt?: unknown;
  result?: unknown;
  inputRequests?: AdapterInputRequest[];
}

export interface AdapterInputRequest {
  key: string;
  description: string;
  inputSchema: unknown;
  required: boolean;
}

export interface StartOperationResponse {
  result: "accepted" | "rejected";
  accepted?: { externalExecutionId: string; initialSnapshot: ExecutionSnapshot };
  rejected?: { reasonCode: string; message: string; retryable: boolean };
}

export interface AvailabilityCheckInput {
  requestId: string;
  operationName: string;
  arguments?: Record<string, unknown>;
  unresolvedArguments?: {
    knownArguments: Record<string, unknown>;
    unresolvedPaths: string[];
  };
  timing?: Record<string, unknown>;
}

export interface AvailabilityResult {
  requestId: string;
  operationName: string;
  availability: string;
  riskLevel: string;
  reasonCode: string;
  description: string;
  validUntil?: unknown;
  earliestStartTime?: unknown;
  nextAvailableWindows: { startTime?: unknown; endTime?: unknown }[];
  estimatedDelayMs: string | number;
  possibleEffects: string[];
}

export interface CheckAvailabilityResponse {
  profileVersion: string;
  checkedAt?: unknown;
  checks: AvailabilityResult[];
}

export interface ReconcileExecutionResponse {
  status: string;
  snapshot?: ExecutionSnapshot;
  externalExecutionId: string;
  reasonCode: string;
  message: string;
  retryable: boolean;
}

export interface CommandAck {
  accepted: boolean;
  reasonCode: string;
  message: string;
  commandSequence: string | number;
}
