import type {
  BusinessEventLease,
  BusinessEventRepository,
  BusinessEventSourceFact,
} from "../../packages/persistence-postgres/src/index.js";

export const BUSINESS_EVENT_RETENTION_MS = 604_800_000;
export const MAPPING_DEADLINE_MS = 60_000;

export function sourceFact(
  sourceStreamId: string,
  sourceSequence: string,
  overrides: Partial<BusinessEventSourceFact> = {},
): BusinessEventSourceFact {
  return {
    sourceEventId: `event-${sourceSequence}`,
    sourceSequence,
    sourceStreamId,
    scope: "resource",
    resourceRef: "vehicle:42",
    occurredAt: "2026-07-22T01:02:03.123456789Z",
    eventType: "vehicle.state.changed",
    description: `Vehicle state changed at source sequence ${sourceSequence}.`,
    severityHint: "info",
    reasonCode: "STATE_CHANGED",
    rawPayload: { sequence: sourceSequence },
    ...overrides,
  };
}

export async function requireLease(
  repository: BusinessEventRepository,
  providerId: string,
  sourceId: string,
  sourceStreamId: string,
  owner: string,
  leaseMs = 30_000,
): Promise<BusinessEventLease> {
  const lease = await repository.acquireSourceLease(
    providerId,
    sourceId,
    sourceStreamId,
    owner,
    leaseMs,
  );
  if (lease === undefined) throw new Error(`Expected ${owner} to acquire source lease`);
  return lease;
}
