export type AvailabilityState = "available" | "restricted" | "disabled" | "unknown";
export type RiskLevel = "low" | "medium" | "high" | "critical" | "unspecified";

export interface AvailabilityCheck {
  requestId: string;
  operationName: string;
  arguments:
    | Record<string, unknown>
    | {
        unresolved: true;
        knownArguments: Record<string, unknown>;
        unresolvedPaths: string[];
      };
  timing?: {
    start?: {
      mode: "immediate" | "scheduled";
      scheduledAt?: string;
      startToleranceMs?: number;
    };
    maxElapsedMs?: number | null;
  };
}

export interface AvailabilityResultValue {
  requestId: string;
  operationName: string;
  availability: AvailabilityState;
  riskLevel?: RiskLevel;
  reasonCode?: string;
  description?: string;
  validUntil?: string;
  earliestStartTime?: string;
  nextAvailableWindows?: { startTime: string; endTime: string }[];
  estimatedDelayMs?: number;
  possibleEffects?: string[];
}

export interface AvailabilityResponseValue {
  profileVersion: "1.0";
  checkedAt: string;
  checks: AvailabilityResultValue[];
}

export function validateAvailabilityResponse(
  checkedAt: Date,
  requested: AvailabilityCheck[],
  results: AvailabilityResultValue[],
): AvailabilityResponseValue {
  if (results.length !== requested.length) throw new Error("AVAILABILITY_RESULT_COUNT_MISMATCH");
  const requestedById = new Map(requested.map((check) => [check.requestId, check]));
  const seen = new Set<string>();
  for (const result of results) {
    if (
      !(["available", "restricted", "disabled", "unknown"] as string[]).includes(
        result.availability,
      )
    ) {
      throw new Error("AVAILABILITY_INVALID_STATE");
    }
    const request = requestedById.get(result.requestId);
    if (request?.operationName !== result.operationName || seen.has(result.requestId)) {
      throw new Error("AVAILABILITY_RESULT_IDENTITY_MISMATCH");
    }
    seen.add(result.requestId);
    if (result.validUntil !== undefined) {
      const validUntil = Date.parse(result.validUntil);
      if (!Number.isFinite(validUntil)) throw new Error("AVAILABILITY_INVALID_VALID_UNTIL");
      if (validUntil < checkedAt.getTime()) {
        throw new Error("AVAILABILITY_VALID_UNTIL_BEFORE_CHECKED_AT");
      }
    }
    if (result.availability === "available" && result.validUntil === undefined) {
      throw new Error("AVAILABLE_REQUIRES_VALID_UNTIL");
    }
    if (result.availability === "restricted") {
      if (
        !result.reasonCode ||
        result.riskLevel === undefined ||
        result.validUntil === undefined ||
        result.possibleEffects === undefined
      ) {
        throw new Error("RESTRICTED_AVAILABILITY_FIELDS_MISSING");
      }
    }
    let previousStart = Number.NEGATIVE_INFINITY;
    for (const window of result.nextAvailableWindows ?? []) {
      const start = Date.parse(window.startTime);
      const end = Date.parse(window.endTime);
      if (
        !Number.isFinite(start) ||
        !Number.isFinite(end) ||
        start >= end ||
        start < previousStart
      ) {
        throw new Error("INVALID_AVAILABILITY_WINDOW");
      }
      previousStart = start;
    }
  }
  return { profileVersion: "1.0", checkedAt: checkedAt.toISOString(), checks: results };
}

export function unknownAvailability(
  requested: AvailabilityCheck[],
  checkedAt = new Date(),
): AvailabilityResponseValue {
  return {
    profileVersion: "1.0",
    checkedAt: checkedAt.toISOString(),
    checks: requested.map((check) => ({
      requestId: check.requestId,
      operationName: check.operationName,
      availability: "unknown",
      riskLevel: "unspecified",
      reasonCode: "ADAPTER_TRANSIENT_UNAVAILABLE",
      description: "Availability could not be determined; final admission still applies.",
    })),
  };
}
