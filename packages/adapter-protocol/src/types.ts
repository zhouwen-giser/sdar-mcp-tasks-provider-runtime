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
  inputRequests?: unknown[];
}
