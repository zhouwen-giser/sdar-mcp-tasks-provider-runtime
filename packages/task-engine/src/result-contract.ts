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
  if (snapshot.state === "SUCCEEDED" || snapshot.state === "PARTIALLY_COMPLETED") {
    operation.validateOutput(adapterResultPayload(snapshot));
  }
}

export function validatedSnapshotTransition(
  operation: ValidatedOperation,
  snapshot: ExecutionSnapshot,
): SnapshotTransition {
  try {
    assertAdapterResultContract(operation, snapshot);
    return mapAdapterSnapshot(normalizeSnapshot(snapshot));
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
  assertAdapterResultContract(operation, snapshot);
  let transition: SnapshotTransition;
  try {
    transition = mapAdapterSnapshot(normalizeSnapshot(snapshot));
  } catch (error) {
    throw new AdapterContractError("ADAPTER_STATE_INVALID", { cause: error });
  }
  if (!transition.terminal) {
    throw new AdapterContractError("SYNCHRONOUS_OPERATION_RETURNED_NONTERMINAL");
  }
  if (transition.mcpStatus === "failed") {
    throw new TechnicalExecutionError(snapshot.reasonCode || "TECHNICAL_EXECUTION_FAILED");
  }
  const result = transition.result;
  if (result === null) {
    throw new AdapterContractError("SYNCHRONOUS_RESULT_MISSING");
  }
  return result;
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

function normalizeSnapshot(snapshot: ExecutionSnapshot) {
  return {
    state: snapshot.state,
    reasonCode: snapshot.reasonCode,
    message: snapshot.message,
    retryable: snapshot.retryable,
    result: adapterResultPayload(snapshot),
  };
}
