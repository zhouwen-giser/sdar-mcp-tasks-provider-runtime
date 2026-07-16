export type RuntimeErrorKind =
  | "invalid_params"
  | "task_not_found"
  | "task_expired"
  | "capability_not_supported"
  | "adapter_contract"
  | "adapter_transient"
  | "technical_execution"
  | "business_tool";

export abstract class RuntimeError extends Error {
  constructor(
    readonly kind: RuntimeErrorKind,
    readonly reasonCode: string,
    readonly safeMessage: string,
    options?: ErrorOptions,
  ) {
    super(reasonCode, options);
    this.name = new.target.name;
  }
}

export class InvalidParamsError extends RuntimeError {
  constructor(
    reasonCode: string,
    safeMessage = "Invalid request parameters.",
    options?: ErrorOptions,
  ) {
    super("invalid_params", reasonCode, safeMessage, options);
  }
}

export class TaskNotFoundOrUnauthorizedError extends RuntimeError {
  constructor(options?: ErrorOptions) {
    super("task_not_found", "TASK_NOT_FOUND", "Task not found.", options);
  }
}

export class TaskExpiredError extends RuntimeError {
  constructor(options?: ErrorOptions) {
    super("task_expired", "TASK_EXPIRED", "Task handle expired.", options);
  }
}

export class CapabilityNotSupportedError extends RuntimeError {
  constructor(reasonCode: string, options?: ErrorOptions) {
    super("capability_not_supported", reasonCode, "Capability not supported.", options);
  }
}

export class AdapterContractError extends RuntimeError {
  constructor(reasonCode: string, options?: ErrorOptions) {
    super("adapter_contract", reasonCode, "Adapter response violated its contract.", options);
  }
}

export class AdapterTransientError extends RuntimeError {
  constructor(reasonCode = "ADAPTER_TRANSIENT_UNAVAILABLE", options?: ErrorOptions) {
    super("adapter_transient", reasonCode, "Adapter is temporarily unavailable.", options);
  }
}

export class TechnicalExecutionError extends RuntimeError {
  constructor(reasonCode = "TECHNICAL_EXECUTION_FAILED", options?: ErrorOptions) {
    super("technical_execution", reasonCode, "Runtime technical failure.", options);
  }
}

export class BusinessToolError extends RuntimeError {
  constructor(reasonCode: string, safeMessage: string, options?: ErrorOptions) {
    super("business_tool", reasonCode, safeMessage, options);
  }
}

export function isRuntimeError(error: unknown): error is RuntimeError {
  return error instanceof RuntimeError;
}
