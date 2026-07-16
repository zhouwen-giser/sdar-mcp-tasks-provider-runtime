import { randomUUID } from "node:crypto";
import type { Pool, PoolClient } from "pg";
import type {
  AuthorizationContext,
  SnapshotTransition,
  TaskRecord,
} from "../../domain/src/index.js";
import { isTerminalState } from "../../domain/src/index.js";

export interface AdmissionIntentInput {
  taskId: string;
  providerId: string;
  operationName: string;
  operationSnapshotId: string;
  authorization: AuthorizationContext;
  arguments: Record<string, unknown>;
  argumentHash: string;
}

export interface PublishTaskInput extends AdmissionIntentInput {
  externalExecutionId: string;
  transition: SnapshotTransition;
  adapterRevision: number;
  ttlMs: number | null;
  adapterResponse: Record<string, unknown>;
  acceptedAt: Date;
  notBefore: Date;
  latestStartAt: Date;
  deadlineAt: Date | null;
  timing: unknown;
}

export interface PublishScheduledInput extends AdmissionIntentInput {
  acceptedAt: Date;
  notBefore: Date;
  latestStartAt: Date;
  deadlineAt: Date | null;
  ttlMs: number | null;
  timing: unknown;
}

export interface AdmissionIntentRecord extends AdmissionIntentInput {
  state: "PENDING" | "ACCEPTED" | "REJECTED" | "PUBLISHED" | "UNCERTAIN";
}

interface TaskRow {
  task_id: string;
  provider_id: string;
  operation_name: string;
  operation_snapshot_id: string;
  authorization_context_hash: string;
  execution_mode: TaskRecord["executionMode"];
  simulation_id: string | null;
  arguments: Record<string, unknown>;
  argument_hash: string;
  external_execution_id: string | null;
  internal_state: TaskRecord["internalState"];
  mcp_status: TaskRecord["mcpStatus"];
  substate: string | null;
  status_message: string | null;
  result: Record<string, unknown> | null;
  error: Record<string, unknown> | null;
  adapter_revision: string;
  ttl_ms: string | null;
  poll_interval_ms: number;
  created_at: Date;
  updated_at: Date;
  version: string;
  accepted_at: Date;
  not_before: Date | null;
  latest_start_at: Date | null;
  deadline_at: Date | null;
  cancel_requested: boolean;
  stop_reason: string | null;
  timing: Record<string, unknown>;
}

export class TaskRepository {
  constructor(readonly pool: Pool) {}

  async createAdmissionIntent(input: AdmissionIntentInput): Promise<boolean> {
    const result = await this.pool.query(
      `INSERT INTO admission_intent
        (task_id, provider_id, operation_name, operation_snapshot_id,
         authorization_context_hash, execution_mode, simulation_id, arguments,
         argument_hash, state)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8::jsonb,$9,'PENDING')
       ON CONFLICT (task_id) DO NOTHING`,
      [
        input.taskId,
        input.providerId,
        input.operationName,
        input.operationSnapshotId,
        input.authorization.hash,
        input.authorization.executionMode,
        input.authorization.simulationId,
        JSON.stringify(input.arguments),
        input.argumentHash,
      ],
    );
    return result.rowCount === 1;
  }

  async getAdmission(taskId: string): Promise<AdmissionIntentRecord | null> {
    const result = await this.pool.query<{
      task_id: string;
      provider_id: string;
      operation_name: string;
      operation_snapshot_id: string;
      authorization_context_hash: string;
      execution_mode: AuthorizationContext["executionMode"];
      simulation_id: string | null;
      arguments: Record<string, unknown>;
      argument_hash: string;
      state: AdmissionIntentRecord["state"];
    }>("SELECT * FROM admission_intent WHERE task_id=$1", [taskId]);
    const row = result.rows[0];
    if (row === undefined) return null;
    return {
      taskId: row.task_id,
      providerId: row.provider_id,
      operationName: row.operation_name,
      operationSnapshotId: row.operation_snapshot_id,
      authorization: {
        hash: row.authorization_context_hash,
        executionMode: row.execution_mode,
        simulationId: row.simulation_id,
      },
      arguments: row.arguments,
      argumentHash: row.argument_hash,
      state: row.state,
    };
  }

  async markAdmissionUncertain(taskId: string): Promise<void> {
    await this.pool.query(
      "UPDATE admission_intent SET state='UNCERTAIN', updated_at=clock_timestamp() WHERE task_id=$1 AND state='PENDING'",
      [taskId],
    );
  }

  async recordRejection(taskId: string, response: Record<string, unknown>): Promise<void> {
    await this.pool.query(
      `UPDATE admission_intent
       SET state='REJECTED', adapter_response=$2::jsonb, updated_at=clock_timestamp()
       WHERE task_id=$1`,
      [taskId, JSON.stringify(response)],
    );
  }

  async completeAdmissionWithoutTask(
    taskId: string,
    response: Record<string, unknown>,
  ): Promise<void> {
    await this.pool.query(
      `UPDATE admission_intent SET state='PUBLISHED', adapter_response=$2::jsonb,
       updated_at=clock_timestamp() WHERE task_id=$1`,
      [taskId, JSON.stringify(response)],
    );
  }

  async publishAccepted(input: PublishTaskInput): Promise<TaskRecord> {
    const client = await this.pool.connect();
    try {
      await client.query("BEGIN");
      await client.query(
        `UPDATE admission_intent SET state='ACCEPTED', adapter_response=$2::jsonb,
           updated_at=clock_timestamp() WHERE task_id=$1`,
        [input.taskId, JSON.stringify(input.adapterResponse)],
      );
      await client.query(
        `INSERT INTO provider_task
          (task_id, provider_id, operation_name, operation_snapshot_id,
           authorization_context_hash, execution_mode, simulation_id, arguments,
           argument_hash, external_execution_id, internal_state, mcp_status,
           substate, status_message, result, error, adapter_revision, accepted_at, ttl_ms,
           timing, not_before, latest_start_at, deadline_at)
         VALUES ($1,$2,$3,$4,$5,$6,$7,$8::jsonb,$9,$10,$11,$12,$13,$14,$15::jsonb,
                 $16::jsonb,$17,$18,$19,$20::jsonb,$21,$22,$23)`,
        [
          input.taskId,
          input.providerId,
          input.operationName,
          input.operationSnapshotId,
          input.authorization.hash,
          input.authorization.executionMode,
          input.authorization.simulationId,
          JSON.stringify(input.arguments),
          input.argumentHash,
          input.externalExecutionId,
          input.transition.internalState,
          input.transition.mcpStatus,
          input.transition.substate,
          input.transition.statusMessage,
          jsonOrNull(input.transition.result),
          jsonOrNull(input.transition.error),
          input.adapterRevision,
          input.acceptedAt,
          input.ttlMs,
          JSON.stringify(input.timing),
          input.notBefore,
          input.latestStartAt,
          input.deadlineAt,
        ],
      );
      const revision = Math.max(1, input.adapterRevision);
      await insertObservation(client, input.taskId, revision, input.transition);
      await insertOutbox(client, input.taskId, "task.created", {
        status: input.transition.mcpStatus,
      });
      await client.query(
        "UPDATE admission_intent SET state='PUBLISHED', updated_at=clock_timestamp() WHERE task_id=$1",
        [input.taskId],
      );
      await client.query("COMMIT");
      const task = await this.getById(input.taskId);
      if (task === null) throw new Error("TASK_NOT_VISIBLE_AFTER_COMMIT");
      return task;
    } catch (error) {
      await client.query("ROLLBACK").catch(() => undefined);
      throw error;
    } finally {
      client.release();
    }
  }

  async publishScheduled(input: PublishScheduledInput): Promise<TaskRecord> {
    const client = await this.pool.connect();
    try {
      await client.query("BEGIN");
      await client.query(
        `INSERT INTO provider_task
          (task_id, provider_id, operation_name, operation_snapshot_id,
           authorization_context_hash, execution_mode, simulation_id, arguments,
           argument_hash, external_execution_id, internal_state, mcp_status,
           substate, status_message, adapter_revision, accepted_at, ttl_ms,
           timing, not_before, latest_start_at, deadline_at)
         VALUES ($1,$2,$3,$4,$5,$6,$7,$8::jsonb,$9,NULL,'SCHEDULED','working',
                 'scheduled','Waiting for scheduled start.',0,$10,$11,$12::jsonb,$13,$14,$15)`,
        [
          input.taskId,
          input.providerId,
          input.operationName,
          input.operationSnapshotId,
          input.authorization.hash,
          input.authorization.executionMode,
          input.authorization.simulationId,
          JSON.stringify(input.arguments),
          input.argumentHash,
          input.acceptedAt,
          input.ttlMs,
          JSON.stringify(input.timing),
          input.notBefore,
          input.latestStartAt,
          input.deadlineAt,
        ],
      );
      await client.query(
        `INSERT INTO task_observation(task_id, revision, type, occurred_at, payload)
         VALUES ($1,0,'task.scheduled',$2,'{}'::jsonb)`,
        [input.taskId, input.acceptedAt],
      );
      await insertOutbox(client, input.taskId, "task.created", {
        status: "working",
        substate: "scheduled",
      });
      await client.query(
        "UPDATE admission_intent SET state='PUBLISHED', updated_at=clock_timestamp() WHERE task_id=$1",
        [input.taskId],
      );
      await client.query("COMMIT");
      const task = await this.getById(input.taskId);
      if (task === null) throw new Error("SCHEDULED_TASK_NOT_VISIBLE_AFTER_COMMIT");
      return task;
    } catch (error) {
      await client.query("ROLLBACK").catch(() => undefined);
      throw error;
    } finally {
      client.release();
    }
  }

  async getAuthorized(taskId: string, authorization: AuthorizationContext): Promise<TaskRecord> {
    const result = await this.pool.query<TaskRow>(
      `SELECT * FROM provider_task
       WHERE task_id=$1 AND authorization_context_hash=$2 AND execution_mode=$3
         AND simulation_id IS NOT DISTINCT FROM $4`,
      [taskId, authorization.hash, authorization.executionMode, authorization.simulationId],
    );
    const row = result.rows[0];
    if (row === undefined) throw new Error("TASK_NOT_FOUND");
    return fromRow(row);
  }

  async getById(taskId: string): Promise<TaskRecord | null> {
    const result = await this.pool.query<TaskRow>("SELECT * FROM provider_task WHERE task_id=$1", [
      taskId,
    ]);
    return result.rows[0] === undefined ? null : fromRow(result.rows[0]);
  }

  async claimDueScheduled(now: Date, ownerId: string, limit = 32): Promise<TaskRecord[]> {
    const result = await this.pool.query<TaskRow>(
      `WITH due AS (
         SELECT task_id FROM provider_task
         WHERE external_execution_id IS NULL AND not_before <= $1
           AND (internal_state='SCHEDULED' OR
                (internal_state='STARTING' AND schedule_claim_until < $1))
         ORDER BY not_before, task_id
         FOR UPDATE SKIP LOCKED LIMIT $3
       )
       UPDATE provider_task task SET internal_state='STARTING',
         status_message='Claimed for scheduled start.', schedule_claim_owner=$2,
         schedule_claim_until=$1 + interval '30 seconds', version=version+1,
         updated_at=clock_timestamp()
       FROM due WHERE task.task_id=due.task_id RETURNING task.*`,
      [now, ownerId, limit],
    );
    return result.rows.map(fromRow);
  }

  async acceptScheduled(
    taskId: string,
    externalExecutionId: string,
    adapterRevision: number,
    transition: SnapshotTransition,
    adapterResponse: Record<string, unknown>,
  ): Promise<TaskRecord> {
    const client = await this.pool.connect();
    try {
      await client.query("BEGIN");
      const updated = await client.query<TaskRow>(
        `UPDATE provider_task SET external_execution_id=$2, internal_state=$3,
           mcp_status=$4, substate=$5, status_message=$6, result=$7::jsonb,
           error=$8::jsonb, adapter_revision=$9, actual_started_at=clock_timestamp(),
           schedule_claim_owner=NULL, schedule_claim_until=NULL, version=version+1,
           updated_at=clock_timestamp()
         WHERE task_id=$1 AND internal_state='STARTING' RETURNING *`,
        [
          taskId,
          externalExecutionId,
          transition.internalState,
          transition.mcpStatus,
          transition.substate,
          transition.statusMessage,
          jsonOrNull(transition.result),
          jsonOrNull(transition.error),
          adapterRevision,
        ],
      );
      const row = updated.rows[0];
      if (row === undefined) throw new Error("SCHEDULED_TASK_CLAIM_LOST");
      await insertObservation(client, taskId, Math.max(1, adapterRevision), transition);
      await insertOutbox(client, taskId, "task.started", { status: transition.mcpStatus });
      await client.query(
        `UPDATE admission_intent SET state='PUBLISHED', adapter_response=$2::jsonb,
         updated_at=clock_timestamp() WHERE task_id=$1`,
        [taskId, JSON.stringify(adapterResponse)],
      );
      await client.query("COMMIT");
      return fromRow(row);
    } catch (error) {
      await client.query("ROLLBACK").catch(() => undefined);
      throw error;
    } finally {
      client.release();
    }
  }

  async releaseScheduleClaim(taskId: string, message: string): Promise<void> {
    await this.pool.query(
      `UPDATE provider_task SET internal_state='SCHEDULED', substate='scheduled',
       status_message=$2, schedule_claim_owner=NULL, schedule_claim_until=NULL,
       version=version+1, updated_at=clock_timestamp()
       WHERE task_id=$1 AND internal_state='STARTING'`,
      [taskId, message],
    );
  }

  async completeStartWindowMissed(taskId: string, completedAt: Date): Promise<TaskRecord> {
    const result = await this.pool.query<TaskRow>(
      `UPDATE provider_task SET internal_state='TERMINAL_COMPLETED', mcp_status='completed',
       substate=NULL, status_message='Scheduled start window was missed.',
       result=$2::jsonb, schedule_claim_owner=NULL, schedule_claim_until=NULL,
       version=version+1, updated_at=$3
       WHERE task_id=$1 AND internal_state IN ('SCHEDULED','STARTING') RETURNING *`,
      [
        taskId,
        JSON.stringify({
          content: [{ type: "text", text: "Scheduled start window was missed." }],
          isError: true,
          structuredContent: {
            outcome: "start_window_missed",
            reasonCode: "START_WINDOW_MISSED",
            retryable: true,
            completedAt: completedAt.toISOString(),
          },
        }),
        completedAt,
      ],
    );
    const row = result.rows[0];
    if (row === undefined) throw new Error("SCHEDULED_TASK_NOT_COMPLETED");
    return fromRow(row);
  }

  async completeScheduledRejection(
    taskId: string,
    completedAt: Date,
    reasonCode: string,
    message: string,
    retryable: boolean,
  ): Promise<TaskRecord> {
    const result = await this.pool.query<TaskRow>(
      `UPDATE provider_task SET internal_state='TERMINAL_COMPLETED', mcp_status='completed',
       substate=NULL, status_message=$3, result=$2::jsonb,
       schedule_claim_owner=NULL, schedule_claim_until=NULL, version=version+1,
       updated_at=$4 WHERE task_id=$1 AND internal_state='STARTING' RETURNING *`,
      [
        taskId,
        JSON.stringify({
          content: [{ type: "text", text: message }],
          isError: true,
          structuredContent: {
            outcome: "admission_rejected",
            reasonCode,
            retryable,
            completedAt: completedAt.toISOString(),
          },
        }),
        message,
        completedAt,
      ],
    );
    const row = result.rows[0];
    if (row === undefined) throw new Error("SCHEDULED_REJECTION_NOT_COMPLETED");
    return fromRow(row);
  }

  async claimExpiredDeadlines(now: Date, limit = 32): Promise<TaskRecord[]> {
    const result = await this.pool.query<TaskRow>(
      `WITH expired AS (
         SELECT task_id FROM provider_task
         WHERE deadline_at <= $1 AND cancel_requested=false
           AND external_execution_id IS NOT NULL
           AND internal_state NOT LIKE 'TERMINAL_%'
         ORDER BY deadline_at, task_id FOR UPDATE SKIP LOCKED LIMIT $2
       )
       UPDATE provider_task task SET internal_state='STOPPING', mcp_status='working',
         substate='stopping', status_message='Deadline reached; safe stop requested.',
         cancel_requested=true, stop_reason='DEADLINE_REACHED', version=version+1,
         updated_at=clock_timestamp()
       FROM expired WHERE task.task_id=expired.task_id RETURNING task.*`,
      [now, limit],
    );
    return result.rows.map(fromRow);
  }

  async applySnapshot(
    taskId: string,
    adapterRevision: number,
    transition: SnapshotTransition,
  ): Promise<TaskRecord> {
    const client = await this.pool.connect();
    try {
      await client.query("BEGIN");
      const locked = await client.query<TaskRow>(
        "SELECT * FROM provider_task WHERE task_id=$1 FOR UPDATE",
        [taskId],
      );
      const existingRow = locked.rows[0];
      if (existingRow === undefined) throw new Error("TASK_NOT_FOUND");
      const existing = fromRow(existingRow);
      if (isTerminalState(existing.internalState) || adapterRevision <= existing.adapterRevision) {
        await client.query("COMMIT");
        return existing;
      }
      const updated = await client.query<TaskRow>(
        `UPDATE provider_task SET internal_state=$2, mcp_status=$3, substate=$4,
           status_message=$5, result=$6::jsonb, error=$7::jsonb, adapter_revision=$8,
           updated_at=clock_timestamp(), version=version+1
         WHERE task_id=$1 AND version=$9 RETURNING *`,
        [
          taskId,
          transition.internalState,
          transition.mcpStatus,
          transition.substate,
          transition.statusMessage,
          jsonOrNull(transition.result),
          jsonOrNull(transition.error),
          adapterRevision,
          existing.version,
        ],
      );
      if (updated.rowCount !== 1) throw new Error("TASK_VERSION_CONFLICT");
      await insertObservation(client, taskId, adapterRevision, transition);
      await insertOutbox(client, taskId, "task.updated", { status: transition.mcpStatus });
      await client.query("COMMIT");
      const updatedRow = updated.rows[0];
      if (updatedRow === undefined) throw new Error("TASK_UPDATE_NOT_RETURNED");
      return fromRow(updatedRow);
    } catch (error) {
      await client.query("ROLLBACK");
      throw error;
    } finally {
      client.release();
    }
  }
}

async function insertObservation(
  client: PoolClient,
  taskId: string,
  revision: number,
  transition: SnapshotTransition,
): Promise<void> {
  await client.query(
    `INSERT INTO task_observation(task_id, revision, type, occurred_at, payload)
     VALUES ($1,$2,$3,clock_timestamp(),$4::jsonb) ON CONFLICT DO NOTHING`,
    [
      taskId,
      revision,
      transition.observationType,
      JSON.stringify({ substate: transition.substate }),
    ],
  );
}

async function insertOutbox(
  client: PoolClient,
  taskId: string,
  type: string,
  payload: Record<string, unknown>,
): Promise<void> {
  await client.query(
    "INSERT INTO outbox_event(event_id, aggregate_id, event_type, payload) VALUES ($1,$2,$3,$4::jsonb)",
    [randomUUID(), taskId, type, JSON.stringify(payload)],
  );
}

function jsonOrNull(value: Record<string, unknown> | null): string | null {
  return value === null ? null : JSON.stringify(value);
}

function fromRow(row: TaskRow): TaskRecord {
  return {
    taskId: row.task_id,
    providerId: row.provider_id,
    operationName: row.operation_name,
    operationSnapshotId: row.operation_snapshot_id,
    authorizationContextHash: row.authorization_context_hash,
    executionMode: row.execution_mode,
    simulationId: row.simulation_id,
    arguments: row.arguments,
    argumentHash: row.argument_hash,
    externalExecutionId: row.external_execution_id,
    internalState: row.internal_state,
    mcpStatus: row.mcp_status,
    substate: row.substate,
    statusMessage: row.status_message,
    result: row.result,
    error: row.error,
    adapterRevision: Number(row.adapter_revision),
    ttlMs: row.ttl_ms === null ? null : Number(row.ttl_ms),
    pollIntervalMs: row.poll_interval_ms,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
    version: Number(row.version),
    acceptedAt: row.accepted_at,
    notBefore: row.not_before,
    latestStartAt: row.latest_start_at,
    deadlineAt: row.deadline_at,
    cancelRequested: row.cancel_requested,
    stopReason: row.stop_reason,
    timing: row.timing,
  };
}
