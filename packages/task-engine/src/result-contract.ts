import { protoStructToJson } from "../../adapter-protocol/src/index.js";
import type { ExecutionSnapshot } from "../../adapter-protocol/src/index.js";
import {
  AdapterContractError,
  mapAdapterSnapshot,
  TechnicalExecutionError,
} from "../../domain/src/index.js";
import type { SnapshotTransition } from "../../domain/src/index.js";
import type { ValidatedOperation } from "../../operation-registry/src/index.js";

export function adapterResultPayload(snapshot: ExecutionSnapshot): Record<string, unknown> {
  return protoStructToJson(snapshot.result);
}

export function assertAdapterResultContract(
  operation: ValidatedOperation,
  snapshot: ExecutionSnapshot,
): void {
  const payload = sanitizedAdapterResultPayload(snapshot);
  if (
    snapshot.state === "SUCCEEDED" ||
    snapshot.state === "BUSINESS_FAILED" ||
    snapshot.state === "PARTIALLY_COMPLETED"
  ) {
    operation.validateOutput(payload);
  }
}

export function sanitizedAdapterResultPayload(
  snapshot: ExecutionSnapshot,
): Record<string, unknown> {
  const result = adapterResultPayload(snapshot);
  assertResultLimits(result);
  return sanitizeResult(result) as Record<string, unknown>;
}

export function validatedSnapshotTransition(
  operation: ValidatedOperation,
  snapshot: ExecutionSnapshot,
): SnapshotTransition {
  try {
    const result = sanitizedAdapterResultPayload(snapshot);
    if (
      snapshot.state === "SUCCEEDED" ||
      snapshot.state === "BUSINESS_FAILED" ||
      snapshot.state === "PARTIALLY_COMPLETED"
    ) {
      operation.validateOutput(result);
    }
    return mapAdapterSnapshot(normalizeSnapshot(snapshot, result));
  } catch (error) {
    if (error instanceof AdapterContractError) {
      return technicalFailureTransition(error.reasonCode);
    }
    return technicalFailureTransition("ADAPTER_STATE_INVALID");
  }
}

export function synchronousResult(
  operation: ValidatedOperation,
  snapshot: ExecutionSnapshot,
): Record<string, unknown> {
  const payload = sanitizedAdapterResultPayload(snapshot);
  if (
    snapshot.state === "SUCCEEDED" ||
    snapshot.state === "BUSINESS_FAILED" ||
    snapshot.state === "PARTIALLY_COMPLETED"
  ) {
    operation.validateOutput(payload);
  }
  let transition: SnapshotTransition;
  try {
    transition = mapAdapterSnapshot(normalizeSnapshot(snapshot, payload));
  } catch (error) {
    throw new AdapterContractError("ADAPTER_STATE_INVALID", { cause: error });
  }
  if (!transition.terminal) {
    throw new AdapterContractError("SYNCHRONOUS_OPERATION_RETURNED_NONTERMINAL");
  }
  if (transition.mcpStatus === "failed") {
    throw new TechnicalExecutionError(snapshot.reasonCode || "TECHNICAL_EXECUTION_FAILED");
  }
  const mappedResult = transition.result;
  if (mappedResult === null) {
    throw new AdapterContractError("SYNCHRONOUS_RESULT_MISSING");
  }
  return mappedResult;
}

function technicalFailureTransition(reasonCode: string): SnapshotTransition {
  return mapAdapterSnapshot({
    state: "TECHNICAL_FAILED",
    reasonCode,
    message: "Adapter result failed Runtime contract validation.",
    retryable: false,
    result: {},
  });
}

function normalizeSnapshot(snapshot: ExecutionSnapshot, result: Record<string, unknown>) {
  return {
    state: snapshot.state,
    reasonCode: snapshot.reasonCode,
    message: snapshot.message,
    retryable: snapshot.retryable,
    result,
  };
}

function assertResultLimits(value: unknown): void {
  let serialized: string;
  try {
    serialized = JSON.stringify(value);
  } catch (error) {
    throw new AdapterContractError("ADAPTER_RESULT_NOT_JSON", { cause: error });
  }
  if (Buffer.byteLength(serialized) > 1_048_576) {
    throw new AdapterContractError("ADAPTER_RESULT_TOO_LARGE");
  }
  let nodes = 0;
  const visit = (item: unknown, depth: number): void => {
    nodes += 1;
    if (nodes > 10_000) throw new AdapterContractError("ADAPTER_RESULT_TOO_COMPLEX");
    if (depth > 32) throw new AdapterContractError("ADAPTER_RESULT_TOO_DEEP");
    if (Array.isArray(item)) {
      for (const child of item) visit(child, depth + 1);
    } else if (typeof item === "object" && item !== null) {
      for (const child of Object.values(item)) visit(child, depth + 1);
    }
  };
  visit(value, 0);
}

function sanitizeResult(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(sanitizeResult);
  if (typeof value !== "object" || value === null) return value;
  const sanitized: Record<string, unknown> = {};
  for (const [key, child] of Object.entries(value)) {
    if (key === "__proto__" || key === "prototype" || key === "constructor") continue;
    sanitized[key] = sanitizeResult(child);
  }
  return sanitized;
}
