import { describe, expect, it } from "vitest";
import { TaskRepository } from "../../packages/persistence-postgres/src/index.js";

describe("MRTR durable recovery surface", () => {
  it("R-001 R-002 exposes durable response promotion independently from beginCommand", () => {
    const prototype = TaskRepository.prototype as unknown as {
      promotePendingInputResponses?: unknown;
    };
    expect(typeof prototype.promotePendingInputResponses).toBe("function");
  });
});
