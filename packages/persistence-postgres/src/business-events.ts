import { createHash, randomBytes, randomUUID } from "node:crypto";
import type { Pool, PoolClient } from "pg";

export type BusinessEventDeliverySemantics = "durable_at_least_once" | "best_effort_live";
export type BusinessEventContinuityClass = "all_durable" | "mixed" | "best_effort_only";

export interface BusinessEventSourceDefinition {
  sourceId: string;
  sourceStreamId: string;
  deliverySemantics: BusinessEventDeliverySemantics;
}

export interface BusinessEventGeneration {
  providerId: string;
  streamId: string;
  status: "current" | "rotating" | "replayable_closed" | "retired";
  currentSequence: string;
  earliestAvailableSequence: string;
  lastReplayableSequence: string;
  lastContinuousSequence: string | null;
  continuityClass: BusinessEventContinuityClass;
}

export interface BusinessEventLease {
  providerId: string;
  sourceId: string;
  sourceStreamId: string;
  owner: string;
  fencingToken: string;
  leaseUntil: Date;
  lastPersistedSourceSequence: string;
  lastFinalizedSourceSequence: string;
}

export interface ProjectionIdentity {
  providerId: string;
  streamId: string;
  eventId: string;
  authorizationScopeHash: string;
  executionMode: "live" | "simulation" | "historical-replay";
  simulationId: string | null;
  candidateRelationHash: string;
  projectionRelationHash: string;
}

export interface ProjectionPage {
  items: string[];
  total: number;
  nextAfterTaskId?: string;
}

export class BusinessEventRepository {
  constructor(readonly pool: Pool) {}

  async initializeProvider(
    providerId: string,
    sources: BusinessEventSourceDefinition[],
    generationRetentionMs: number,
  ): Promise<BusinessEventGeneration> {
    if (sources.length < 1 || sources.length > 16)
      throw new Error("BUSINESS_EVENT_SOURCE_COUNT_INVALID");
    const client = await this.pool.connect();
    try {
      await client.query("BEGIN");
      const existing = await client.query<GenerationRow>(
        `SELECT g.* FROM provider_business_event_runtime_state r
         JOIN provider_business_event_stream_generation g
           ON g.provider_id=r.provider_id AND g.stream_id=r.current_stream_id
         WHERE r.provider_id=$1 FOR UPDATE OF r, g`,
        [providerId],
      );
      if (existing.rows[0] !== undefined) {
        await client.query("COMMIT");
        return mapGeneration(existing.rows[0]);
      }

      const streamId = randomUUID();
      const continuityClass = classifyContinuity(sources);
      await client.query(
        `INSERT INTO provider_business_event_stream_generation
           (provider_id, stream_id, status, continuity_class, retain_until)
         VALUES ($1,$2,'current',$3,clock_timestamp() + ($4 * interval '1 millisecond'))`,
        [providerId, streamId, continuityClass, generationRetentionMs],
      );
      await client.query(
        `INSERT INTO provider_business_event_runtime_state
           (provider_id, current_stream_id, generation_version) VALUES ($1,$2,1)`,
        [providerId, streamId],
      );
      for (const source of [...sources].sort((left, right) =>
        compareText(left.sourceId, right.sourceId),
      )) {
        await client.query(
          `INSERT INTO provider_business_event_generation_source
             (provider_id, runtime_stream_id, source_id, source_stream_id,
              delivery_semantics, joined_at_runtime_sequence)
           VALUES ($1,$2,$3,$4,$5,0)`,
          [providerId, streamId, source.sourceId, source.sourceStreamId, source.deliverySemantics],
        );
        await client.query(
          `INSERT INTO adapter_business_event_source_state
             (provider_id, source_id, source_stream_id, delivery_semantics, status)
           VALUES ($1,$2,$3,$4,'active')`,
          [providerId, source.sourceId, source.sourceStreamId, source.deliverySemantics],
        );
      }
      await client.query("COMMIT");
      return {
        providerId,
        streamId,
        status: "current",
        currentSequence: "0",
        earliestAvailableSequence: "1",
        lastReplayableSequence: "0",
        lastContinuousSequence: null,
        continuityClass,
      };
    } catch (error) {
      await client.query("ROLLBACK");
      throw error;
    } finally {
      client.release();
    }
  }

  async currentGeneration(providerId: string): Promise<BusinessEventGeneration | undefined> {
    const result = await this.pool.query<GenerationRow>(
      `SELECT g.* FROM provider_business_event_runtime_state r
       JOIN provider_business_event_stream_generation g
         ON g.provider_id=r.provider_id AND g.stream_id=r.current_stream_id
       WHERE r.provider_id=$1`,
      [providerId],
    );
    return result.rows[0] === undefined ? undefined : mapGeneration(result.rows[0]);
  }

  async generation(
    providerId: string,
    streamId: string,
  ): Promise<BusinessEventGeneration | undefined> {
    const result = await this.pool.query<GenerationRow>(
      `SELECT * FROM provider_business_event_stream_generation WHERE provider_id=$1 AND stream_id=$2`,
      [providerId, streamId],
    );
    return result.rows[0] === undefined ? undefined : mapGeneration(result.rows[0]);
  }

  async sourceRoster(
    providerId: string,
    streamId: string,
  ): Promise<BusinessEventSourceDefinition[]> {
    const result = await this.pool.query<{
      source_id: string;
      source_stream_id: string;
      delivery_semantics: BusinessEventDeliverySemantics;
    }>(
      `SELECT source_id, source_stream_id, delivery_semantics
       FROM provider_business_event_generation_source
       WHERE provider_id=$1 AND runtime_stream_id=$2 ORDER BY source_id`,
      [providerId, streamId],
    );
    return result.rows.map((row) => ({
      sourceId: row.source_id,
      sourceStreamId: row.source_stream_id,
      deliverySemantics: row.delivery_semantics,
    }));
  }

  async acquireSourceLease(
    providerId: string,
    sourceId: string,
    sourceStreamId: string,
    owner: string,
    leaseMs: number,
  ): Promise<BusinessEventLease | undefined> {
    const result = await this.pool.query<SourceStateRow>(
      `UPDATE adapter_business_event_source_state
       SET lease_owner=$4,
           lease_until=clock_timestamp() + ($5 * interval '1 millisecond'),
           fencing_token=fencing_token + 1,
           updated_at=clock_timestamp()
       WHERE provider_id=$1 AND source_id=$2 AND source_stream_id=$3
         AND status NOT LIKE 'blocked_%'
         AND status <> 'continuity_loss_pending'
         AND (lease_until IS NULL OR lease_until <= clock_timestamp() OR lease_owner=$4)
       RETURNING *`,
      [providerId, sourceId, sourceStreamId, owner, leaseMs],
    );
    return result.rows[0] === undefined ? undefined : mapLease(result.rows[0]);
  }

  async renewSourceLease(lease: BusinessEventLease, leaseMs: number): Promise<BusinessEventLease> {
    const result = await this.pool.query<SourceStateRow>(
      `UPDATE adapter_business_event_source_state
       SET lease_until=clock_timestamp() + ($6 * interval '1 millisecond'), updated_at=clock_timestamp()
       WHERE provider_id=$1 AND source_id=$2 AND source_stream_id=$3
         AND lease_owner=$4 AND fencing_token=$5 AND lease_until > clock_timestamp()
       RETURNING *`,
      [
        lease.providerId,
        lease.sourceId,
        lease.sourceStreamId,
        lease.owner,
        lease.fencingToken,
        leaseMs,
      ],
    );
    const row = result.rows[0];
    if (row === undefined) throw new Error("BUSINESS_EVENT_STALE_FENCE");
    return mapLease(row);
  }

  async createRelationProjection(
    identity: ProjectionIdentity,
    taskIds: string[],
    ttlMs: number,
  ): Promise<string> {
    const token = randomBytes(32).toString("base64url");
    const tokenHash = hashToken(token);
    const sorted = [...new Set(taskIds)].sort(compareText);
    const client = await this.pool.connect();
    try {
      await client.query("BEGIN");
      await lockRuntimeAndGeneration(client, identity.providerId, identity.streamId);
      await client.query(
        `INSERT INTO provider_business_event_relation_projection
           (token_hash, provider_id, stream_id, event_id, authorization_scope_hash,
            execution_mode, simulation_id, candidate_relation_hash,
            projection_relation_hash, expires_at)
         VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,clock_timestamp() + ($10 * interval '1 millisecond'))`,
        [
          tokenHash,
          identity.providerId,
          identity.streamId,
          identity.eventId,
          identity.authorizationScopeHash,
          identity.executionMode,
          identity.simulationId,
          identity.candidateRelationHash,
          identity.projectionRelationHash,
          ttlMs,
        ],
      );
      for (const [ordinal, taskId] of sorted.entries()) {
        await client.query(
          `INSERT INTO provider_business_event_relation_projection_item(token_hash, task_id, ordinal)
           VALUES ($1,$2,$3)`,
          [tokenHash, taskId, ordinal],
        );
      }
      await client.query("COMMIT");
      return token;
    } catch (error) {
      await client.query("ROLLBACK");
      throw error;
    } finally {
      client.release();
    }
  }

  async relationProjectionPage(
    token: string,
    authorization: Pick<
      ProjectionIdentity,
      "authorizationScopeHash" | "executionMode" | "simulationId"
    >,
    afterTaskId: string | undefined,
    limit: number,
  ): Promise<ProjectionPage> {
    if (limit < 1 || limit > 256) throw new Error("BUSINESS_EVENT_RELATION_CURSOR_INVALID");
    const tokenHash = hashToken(token);
    const projection = await this.pool.query<{
      authorization_scope_hash: string;
      execution_mode: string;
      simulation_id: string | null;
      expires_at: Date;
      total: string;
    }>(
      `SELECT p.authorization_scope_hash, p.execution_mode, p.simulation_id, p.expires_at,
              count(i.task_id)::text AS total
       FROM provider_business_event_relation_projection p
       LEFT JOIN provider_business_event_relation_projection_item i ON i.token_hash=p.token_hash
       WHERE p.token_hash=$1
       GROUP BY p.token_hash`,
      [tokenHash],
    );
    const row = projection.rows[0];
    if (row === undefined) throw new Error("BUSINESS_EVENT_RELATION_CURSOR_INVALID");
    if (row.expires_at <= new Date()) throw new Error("BUSINESS_EVENT_RELATION_CURSOR_EXPIRED");
    if (
      row.authorization_scope_hash !== authorization.authorizationScopeHash ||
      row.execution_mode !== authorization.executionMode ||
      row.simulation_id !== authorization.simulationId
    ) {
      throw new Error("BUSINESS_EVENT_AUTHORIZATION_MISMATCH");
    }
    if (afterTaskId !== undefined) {
      const anchor = await this.pool.query(
        `SELECT 1 FROM provider_business_event_relation_projection_item
         WHERE token_hash=$1 AND task_id=$2`,
        [tokenHash, afterTaskId],
      );
      if (anchor.rowCount !== 1) throw new Error("BUSINESS_EVENT_RELATION_CURSOR_INVALID");
    }
    const items = await this.pool.query<{ task_id: string }>(
      `SELECT task_id::text FROM provider_business_event_relation_projection_item
       WHERE token_hash=$1 AND ($2::uuid IS NULL OR task_id > $2::uuid)
       ORDER BY task_id LIMIT $3`,
      [tokenHash, afterTaskId ?? null, limit],
    );
    const taskIds = items.rows.map((item) => item.task_id);
    const lastTaskId = taskIds.at(-1);
    return {
      items: taskIds,
      total: Number(row.total),
      ...(lastTaskId === undefined ? {} : { nextAfterTaskId: lastTaskId }),
    };
  }
}

interface GenerationRow {
  provider_id: string;
  stream_id: string;
  status: BusinessEventGeneration["status"];
  current_sequence: string;
  earliest_available_sequence: string;
  last_replayable_sequence: string;
  last_continuous_sequence: string | null;
  continuity_class: BusinessEventContinuityClass;
}

interface SourceStateRow {
  provider_id: string;
  source_id: string;
  source_stream_id: string;
  lease_owner: string;
  lease_until: Date;
  fencing_token: string;
  last_persisted_source_sequence: string;
  last_finalized_source_sequence: string;
}

function mapGeneration(row: GenerationRow): BusinessEventGeneration {
  return {
    providerId: row.provider_id,
    streamId: row.stream_id,
    status: row.status,
    currentSequence: row.current_sequence,
    earliestAvailableSequence: row.earliest_available_sequence,
    lastReplayableSequence: row.last_replayable_sequence,
    lastContinuousSequence: row.last_continuous_sequence,
    continuityClass: row.continuity_class,
  };
}

function mapLease(row: SourceStateRow): BusinessEventLease {
  return {
    providerId: row.provider_id,
    sourceId: row.source_id,
    sourceStreamId: row.source_stream_id,
    owner: row.lease_owner,
    fencingToken: row.fencing_token,
    leaseUntil: row.lease_until,
    lastPersistedSourceSequence: row.last_persisted_source_sequence,
    lastFinalizedSourceSequence: row.last_finalized_source_sequence,
  };
}

function classifyContinuity(
  sources: BusinessEventSourceDefinition[],
): BusinessEventContinuityClass {
  const durable = sources.filter(
    (source) => source.deliverySemantics === "durable_at_least_once",
  ).length;
  return durable === sources.length ? "all_durable" : durable === 0 ? "best_effort_only" : "mixed";
}

function hashToken(token: string): string {
  if (!/^[A-Za-z0-9_-]{22,256}$/.test(token))
    throw new Error("BUSINESS_EVENT_RELATION_CURSOR_INVALID");
  return createHash("sha256").update(token).digest("hex");
}

function compareText(left: string, right: string): number {
  return left < right ? -1 : left > right ? 1 : 0;
}

async function lockRuntimeAndGeneration(
  client: PoolClient,
  providerId: string,
  streamId: string,
): Promise<void> {
  const runtime = await client.query(
    `SELECT 1 FROM provider_business_event_runtime_state WHERE provider_id=$1 FOR UPDATE`,
    [providerId],
  );
  if (runtime.rowCount !== 1) throw new Error("BUSINESS_EVENT_NOT_FOUND");
  const generation = await client.query(
    `SELECT 1 FROM provider_business_event_stream_generation
     WHERE provider_id=$1 AND stream_id=$2 FOR UPDATE`,
    [providerId, streamId],
  );
  if (generation.rowCount !== 1) throw new Error("BUSINESS_EVENT_STREAM_RESET");
}
