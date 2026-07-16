import { describe, expect, it } from "vitest";
import {
  unknownAvailability,
  validateAvailabilityResponse,
} from "../../packages/domain/src/index.js";

const checks = [
  { requestId: "one", operationName: "op", arguments: {} },
  { requestId: "two", operationName: "op", arguments: {} },
];
const firstCheck = { requestId: "one", operationName: "op", arguments: {} };

describe("availability contract", () => {
  it("validates available/restricted results and ordered windows", () => {
    const checkedAt = new Date("2026-07-16T00:00:00Z");
    expect(
      validateAvailabilityResponse(checkedAt, checks, [
        {
          requestId: "one",
          operationName: "op",
          availability: "available",
          validUntil: "2026-07-16T00:00:10Z",
        },
        {
          requestId: "two",
          operationName: "op",
          availability: "restricted",
          reasonCode: "BUSY",
          riskLevel: "high",
          validUntil: "2026-07-16T00:00:10Z",
          possibleEffects: ["start_rejection"],
          nextAvailableWindows: [
            { startTime: "2026-07-16T00:01:00Z", endTime: "2026-07-16T00:02:00Z" },
          ],
        },
      ]).checks,
    ).toHaveLength(2);
  });

  it("rejects invalid validity and restricted/window contracts", () => {
    expect(() =>
      validateAvailabilityResponse(
        new Date(),
        [firstCheck],
        [{ requestId: "one", operationName: "op", availability: "available" }],
      ),
    ).toThrow("AVAILABLE_REQUIRES_VALID_UNTIL");
    expect(() =>
      validateAvailabilityResponse(
        new Date("2026-01-01Z"),
        [firstCheck],
        [
          {
            requestId: "one",
            operationName: "op",
            availability: "restricted",
            reasonCode: "BUSY",
            riskLevel: "high",
            validUntil: "2026-01-02Z",
            possibleEffects: [],
            nextAvailableWindows: [{ startTime: "2026-01-03Z", endTime: "2026-01-02Z" }],
          },
        ],
      ),
    ).toThrow("INVALID_AVAILABILITY_WINDOW");
  });

  it("uses explicit unknown fallback without claiming availability", () => {
    const fallback = unknownAvailability(checks);
    expect(fallback.checks.map((check) => check.requestId)).toEqual(["one", "two"]);
    expect(fallback.checks.map((check) => check.availability)).toEqual(["unknown", "unknown"]);
    expect(fallback.checks.map((check) => check.reasonCode)).toEqual([
      "ADAPTER_TRANSIENT_UNAVAILABLE",
      "ADAPTER_TRANSIENT_UNAVAILABLE",
    ]);
  });
});
