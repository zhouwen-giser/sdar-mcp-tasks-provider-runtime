import { createHash, randomUUID } from "node:crypto";
import type { Pool, PoolClient } from "pg";
import type {
  AuthorizationContext,
  SnapshotTransition,
  TaskExecutionTiming,
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
  acceptedAt: Date;
  notBefore: Date;
  latestStartAt: Date;
  deadlineAt: Date | null;
  ttlMs: number | null;
  timing: TaskExecutionTiming;
}

export interface PublishTaskInput extends AdmissionIntentInput {
  externalExecutionId: string;
  transition: SnapshotTransition;
  adapterRevision: number;
  adapterResponse: Record<string, unknown>;
  actualStartedAt?: Date | null;
  startWindowMissedAt?: Date;
  inputRequests?: {
    key: string;
    description: string;
    schema: Record<string, unknown>;
    required: boolean;
  }[];
}

export type PublishScheduledInput = AdmissionIntentInput;

export interface AdmissionIntentRecord extends AdmissionIntentInput {
  state: "PENDING" | "ACCEPTED" | "REJECTED" | "PUBLISHED" | "UNCERTAIN";
}

export interface PendingCommandRecord {
  taskId: string;
  commandSequence: number;
  commandType: "CANCEL" | "UPDATE" | "PAUSE" | "RESUME";
  payload: Record<string, unknown>;
  state: "PENDING" | "CLAIMED" | "RETRY_WAIT" | "ACKNOWLEDGED" | "REJECTED" | "EXHAUSTED";
  attemptCount: number;
  claimOwner: string | null;
  stopReason: string | null;
}

export interface InputRequestRecord {
  key: string;
  description: string;
  schema: Record<string, unknown>;
  required: boolean;
  status: "OPEN" | "ANSWERED";
  answerHash: string | null;
}

export interface ObservationRecord {
  revision: number;
  type: string;
  occurredAt: Date;
  reasonCode: string | null;
  payload: Record<string, unknown>;
}

export interface DeadlineStopRecord {
  task: TaskRecord;
  commandSequence: number;
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
  actual_started_at: Date | null;
  start_stop_requested_at: Date | null;
  invocation_attempt: number;
  next_start_attempt_at: Date | null;
  schedule_claim_owner: string | null;
  schedule_claim_until: Date | null;
  deadline_at: Date | null;
  cancel_requested: boolean;
  stop_reason: string | null;
  next_command_sequence: string;
  timing: Record<string, unknown>;
  recovery_attempts: number;
  last_reconciled_at: Date | null;
}

export class TaskRepository {
  constructor(readonly pool: Pool) {}

  async createAdmissionIntent(input: AdmissionIntentInput): Promise<boolean> {
    const result = await this.pool.query(
      `INSERT INTO admission_intent
        (task_id, provider_id, operation_name, operation_snapshot_id,
         authorization_context_hash, execution_mode, simulation_id, arguments,
         argument_hash, state, accepted_at, not_before, latest_start_at,
         deadline_at, ttl_ms, timing)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8::jsonb,$9,'PENDING',$10,$11,$12,$13,$14,$15::jsonb)
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
        input.acceptedAt,
        input.notBefore,
        input.latestStartAt,
        input.deadlineAt,
        input.ttlMs,
        JSON.stringify(input.timing),
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
      accepted_at: Date;
      not_before: Date;
      latest_start_at: Date;
      deadline_at: Date | null;
      ttl_ms: string | null;
      timing: TaskExecutionTiming;
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
      acceptedAt: row.accepted_at,
      notBefore: row.not_before,
      latestStartAt: row.latest_start_at,
      deadlineAt: row.deadline_at,
      ttlMs: row.ttl_ms === null ? null : Number(row.ttl_ms),
      timing: row.timing,
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
           timing, not_before, latest_start_at, deadline_at, actual_started_at,
           invocation_attempt)
         VALUES ($1,$2,$3,$4,$5,$6,$7,$8::jsonb,$9,$10,$11,$12,$13,$14,$15::jsonb,
                 $16::jsonb,$17,$18,$19,$20::jsonb,$21,$22,$23,
                 $24,$25)`,
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
          input.actualStartedAt ?? null,
          1,
        ],
      );
      if (input.startWindowMissedAt === undefined) {
        const revision = Math.max(1, input.adapterRevision);
        await insertObservation(client, input.taskId, revision, input.transition);
        await insertOutbox(client, input.taskId, "task.created", {
          status: input.transition.mcpStatus,
        });
      } else {
        await persistStartWindowStop(client, input.taskId, input.startWindowMissedAt);
      }
      await upsertInputRequests(client, input.taskId, input.inputRequests ?? []);
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
           timing, not_before, latest_start_at, deadline_at, invocation_attempt,
           next_start_attempt_at)
         VALUES ($1,$2,$3,$4,$5,$6,$7,$8::jsonb,$9,NULL,'SCHEDULED','working',
                 'scheduled','Waiting for scheduled start.',0,$10,$11,$12::jsonb,$13,$14,$15,0,$13)`,
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

  async listAdmissionsForRecovery(limit = 128): Promise<AdmissionIntentRecord[]> {
    const result = await this.pool.query<{ task_id: string }>(
      `SELECT task_id FROM admission_intent
       WHERE state IN ('PENDING','UNCERTAIN')
       ORDER BY updated_at, task_id LIMIT $1`,
      [limit],
    );
    const records = await Promise.all(result.rows.map((row) => this.getAdmission(row.task_id)));
    return records.filter((record): record is AdmissionIntentRecord => record !== null);
  }

  async listTasksForRecovery(limit = 256): Promise<TaskRecord[]> {
    const result = await this.pool.query<TaskRow>(
      `SELECT * FROM provider_task
       WHERE internal_state NOT LIKE 'TERMINAL_%' AND internal_state <> 'SCHEDULED'
       ORDER BY updated_at, task_id LIMIT $1`,
      [limit],
    );
    return result.rows.map(fromRow);
  }

  async withRecoveryLock<T>(taskId: string, recover: () => Promise<T>): Promise<T | null> {
    const leaseKey = `sdar-recovery:${taskId}`;
    const ownerId = randomUUID();
    const claimed = await this.pool.query(
      `INSERT INTO runtime_lease(lease_key, owner_id, fencing_token, expires_at)
       VALUES ($1,$2,1,clock_timestamp() + interval '30 seconds')
       ON CONFLICT (lease_key) DO UPDATE SET
         owner_id=EXCLUDED.owner_id,
         fencing_token=runtime_lease.fencing_token+1,
         expires_at=EXCLUDED.expires_at,
         updated_at=clock_timestamp()
       WHERE runtime_lease.expires_at <= clock_timestamp()
       RETURNING lease_key`,
      [leaseKey, ownerId],
    );
    if (claimed.rowCount !== 1) return null;
    try {
      return await recover();
    } finally {
      await this.pool.query("DELETE FROM runtime_lease WHERE lease_key=$1 AND owner_id=$2", [
        leaseKey,
        ownerId,
      ]);
    }
  }

  async listPendingCommands(taskId: string): Promise<PendingCommandRecord[]> {
    const result = await this.pool.query<{
      task_id: string;
      command_sequence: string;
      command_type: PendingCommandRecord["commandType"];
      payload: Record<string, unknown>;
      state: PendingCommandRecord["state"];
      attempt_count: number;
      claim_owner: string | null;
      stop_reason: string | null;
    }>(
      `SELECT task_id, command_sequence, command_type, payload, state, attempt_count,
              claim_owner, stop_reason
       FROM task_command WHERE task_id=$1 AND state IN ('PENDING','CLAIMED','RETRY_WAIT')
       ORDER BY command_sequence`,
      [taskId],
    );
    return result.rows.map((row) => ({
      taskId: row.task_id,
      commandSequence: Number(row.command_sequence),
      commandType: row.command_type,
      payload: row.payload,
      state: row.state,
      attemptCount: row.attempt_count,
      claimOwner: row.claim_owner,
      stopReason: row.stop_reason,
    }));
  }

  async claimDueCancelCommands(
    now: Date,
    ownerId: string,
    leaseMilliseconds = 30_000,
    limit = 32,
  ): Promise<PendingCommandRecord[]> {
    const result = await this.pool.query<{
      task_id: string;
      command_sequence: string;
      command_type: PendingCommandRecord["commandType"];
      payload: Record<string, unknown>;
      state: PendingCommandRecord["state"];
      attempt_count: number;
      claim_owner: string | null;
      stop_reason: string | null;
    }>(
      `WITH due AS (
         SELECT task_id, command_sequence FROM task_command
         WHERE command_type='CANCEL'
           AND ((state IN ('PENDING','RETRY_WAIT')
                 AND next_attempt_at <= GREATEST($1,clock_timestamp()))
             OR (state='CLAIMED' AND claim_until <= GREATEST($1,clock_timestamp())))
         ORDER BY priority DESC, next_attempt_at, created_at, task_id, command_sequence
         FOR UPDATE SKIP LOCKED LIMIT $4
       )
       UPDATE task_command command SET state='CLAIMED', claim_owner=$2,
         claim_until=GREATEST($1,clock_timestamp()) + ($3::text || ' milliseconds')::interval,
         attempt_count=attempt_count+1, updated_at=clock_timestamp()
       FROM due WHERE command.task_id=due.task_id
         AND command.command_sequence=due.command_sequence
       RETURNING command.task_id, command.command_sequence, command.command_type,
         command.payload, command.state, command.attempt_count, command.claim_owner,
         command.stop_reason`,
      [now, ownerId, leaseMilliseconds, limit],
    );
    return result.rows.map((row) => ({
      taskId: row.task_id,
      commandSequence: Number(row.command_sequence),
      commandType: row.command_type,
      payload: row.payload,
      state: row.state,
      attemptCount: row.attempt_count,
      claimOwner: row.claim_owner,
      stopReason: row.stop_reason,
    }));
  }

  async retryClaimedCommand(
    command: PendingCommandRecord,
    nextAttemptAt: Date,
    errorCode: string,
    errorMessage: string,
  ): Promise<void> {
    const result = await this.pool.query(
      `UPDATE task_command SET state='RETRY_WAIT', next_attempt_at=$4,
         claim_owner=NULL, claim_until=NULL, last_error_code=$5,
         last_error_message=$6, updated_at=clock_timestamp()
       WHERE task_id=$1 AND command_sequence=$2 AND state='CLAIMED' AND claim_owner=$3`,
      [
        command.taskId,
        command.commandSequence,
        command.claimOwner,
        nextAttemptAt,
        errorCode,
        errorMessage,
      ],
    );
    if (result.rowCount !== 1) throw new Error("COMMAND_CLAIM_LOST");
  }

  async noteRecovery(taskId: string): Promise<void> {
    await this.pool.query(
      `UPDATE provider_task SET recovery_attempts=recovery_attempts+1,
       last_reconciled_at=clock_timestamp() WHERE task_id=$1`,
      [taskId],
    );
  }

  async failRecoveryNotFound(taskId: string, message: string): Promise<TaskRecord> {
    const client = await this.pool.connect();
    try {
      await client.query("BEGIN");
      const updated = await client.query<TaskRow>(
        `UPDATE provider_task SET internal_state='TERMINAL_FAILED', mcp_status='failed',
           substate=NULL, status_message=$2, result=NULL,
           error=$3::jsonb, adapter_revision=adapter_revision+1,
           recovery_attempts=recovery_attempts+1, last_reconciled_at=clock_timestamp(),
           version=version+1, updated_at=clock_timestamp()
         WHERE task_id=$1 AND internal_state NOT LIKE 'TERMINAL_%' RETURNING *`,
        [
          taskId,
          message,
          JSON.stringify({ code: -32603, message, data: { reasonCode: "EXECUTION_NOT_FOUND" } }),
        ],
      );
      const row = updated.rows[0];
      if (row === undefined) {
        const existing = await client.query<TaskRow>(
          "SELECT * FROM provider_task WHERE task_id=$1",
          [taskId],
        );
        const existingRow = existing.rows[0];
        if (existingRow === undefined) throw new Error("TASK_NOT_FOUND");
        await client.query("COMMIT");
        return fromRow(existingRow);
      }
      await insertObservation(client, taskId, Number(row.adapter_revision), {
        internalState: "TERMINAL_FAILED",
        mcpStatus: "failed",
        substate: null,
        statusMessage: message,
        result: null,
        error: row.error,
        terminal: true,
        observationType: "task.progress",
      });
      await insertOutbox(client, taskId, "task.recovery_failed", {
        reasonCode: "EXECUTION_NOT_FOUND",
      });
      await client.query("COMMIT");
      return fromRow(row);
    } catch (error) {
      await client.query("ROLLBACK").catch(() => undefined);
      throw error;
    } finally {
      client.release();
    }
  }

  async claimDueScheduled(now: Date, ownerId: string, limit = 32): Promise<TaskRecord[]> {
    const result = await this.pool.query<TaskRow>(
      `WITH due AS (
         SELECT task_id FROM provider_task
         WHERE external_execution_id IS NULL AND internal_state='SCHEDULED'
           AND not_before <= $1 AND COALESCE(next_start_attempt_at,not_before) <= $1
           AND latest_start_at > $1
         ORDER BY COALESCE(next_start_attempt_at,not_before), task_id
         FOR UPDATE SKIP LOCKED LIMIT $3
       )
       UPDATE provider_task task SET internal_state='STARTING',
         status_message='Claimed for scheduled start.', schedule_claim_owner=$2,
         schedule_claim_until=$1 + interval '30 seconds', version=version+1,
         invocation_attempt=invocation_attempt+1, next_start_attempt_at=NULL,
         updated_at=clock_timestamp()
       FROM due WHERE task.task_id=due.task_id RETURNING task.*`,
      [now, ownerId, limit],
    );
    return result.rows.map(fromRow);
  }

  async completeDueStartWindowMisses(now: Date, limit = 32): Promise<number> {
    const client = await this.pool.connect();
    try {
      await client.query("BEGIN");
      const due = await client.query<{ task_id: string }>(
        `SELECT task_id FROM provider_task
         WHERE internal_state='SCHEDULED' AND external_execution_id IS NULL
           AND latest_start_at <= $1
         ORDER BY latest_start_at, task_id FOR UPDATE SKIP LOCKED LIMIT $2`,
        [now, limit],
      );
      for (const row of due.rows) {
        await client.query(
          `UPDATE provider_task SET internal_state='TERMINAL_COMPLETED', mcp_status='completed',
           substate=NULL, status_message='Start window was missed before execution began.',
           result=$2::jsonb, schedule_claim_owner=NULL, schedule_claim_until=NULL,
           next_start_attempt_at=NULL, version=version+1, updated_at=$3
           WHERE task_id=$1`,
          [row.task_id, JSON.stringify(startWindowMissedResult(now)), now],
        );
        const revision = await nextObservationRevision(client, row.task_id);
        await insertObservation(client, row.task_id, revision, startWindowMissedTransition(now));
        await insertOutbox(client, row.task_id, "task.start_window_missed", {
          reasonCode: "START_WINDOW_MISSED",
          safeStopRequired: false,
        });
      }
      await client.query("COMMIT");
      return due.rowCount ?? 0;
    } catch (error) {
      await client.query("ROLLBACK").catch(() => undefined);
      throw error;
    } finally {
      client.release();
    }
  }

  async claimExpiredScheduledStarts(now: Date, ownerId: string, limit = 32): Promise<TaskRecord[]> {
    const result = await this.pool.query<TaskRow>(
      `WITH due AS (
         SELECT task_id FROM provider_task
         WHERE external_execution_id IS NULL AND internal_state='STARTING'
           AND schedule_claim_until <= $1
         ORDER BY schedule_claim_until, task_id
         FOR UPDATE SKIP LOCKED LIMIT $3
       )
       UPDATE provider_task task SET schedule_claim_owner=$2,
         schedule_claim_until=$1 + interval '30 seconds', version=version+1,
         status_message='Reconciling an uncertain scheduled start.',
         updated_at=clock_timestamp()
       FROM due WHERE task.task_id=due.task_id RETURNING task.*`,
      [now, ownerId, limit],
    );
    return result.rows.map(fromRow);
  }

  async acceptScheduled(
    taskId: string,
    claimOwner: string,
    externalExecutionId: string,
    adapterRevision: number,
    transition: SnapshotTransition,
    adapterResponse: Record<string, unknown>,
    inputRequests: {
      key: string;
      description: string;
      schema: Record<string, unknown>;
      required: boolean;
    }[] = [],
    startWindowMissedAt?: Date,
    actualStartedAt?: Date | null,
  ): Promise<TaskRecord> {
    const client = await this.pool.connect();
    try {
      await client.query("BEGIN");
      const updated = await client.query<TaskRow>(
        `UPDATE provider_task SET external_execution_id=$2, internal_state=$3,
           mcp_status=$4, substate=$5, status_message=$6, result=$7::jsonb,
           error=$8::jsonb, adapter_revision=$9,
           actual_started_at=COALESCE(actual_started_at,$10),
           schedule_claim_owner=NULL, schedule_claim_until=NULL, version=version+1,
           updated_at=clock_timestamp()
         WHERE task_id=$1 AND internal_state='STARTING' AND schedule_claim_owner=$11
         RETURNING *`,
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
          actualStartedAt ?? null,
          claimOwner,
        ],
      );
      const row = updated.rows[0];
      if (row === undefined) throw new Error("SCHEDULED_TASK_CLAIM_LOST");
      if (startWindowMissedAt === undefined) {
        await insertObservation(client, taskId, Math.max(1, adapterRevision), transition);
        await insertOutbox(client, taskId, "task.started", { status: transition.mcpStatus });
      } else {
        await persistStartWindowStop(client, taskId, startWindowMissedAt);
      }
      await upsertInputRequests(client, taskId, inputRequests);
      await client.query(
        `UPDATE admission_intent SET state='PUBLISHED', adapter_response=$2::jsonb,
         updated_at=clock_timestamp() WHERE task_id=$1`,
        [taskId, JSON.stringify(adapterResponse)],
      );
      await client.query("COMMIT");
      const visible = await this.getById(taskId);
      if (visible === null) throw new Error("SCHEDULED_TASK_NOT_VISIBLE_AFTER_COMMIT");
      return visible;
    } catch (error) {
      await client.query("ROLLBACK").catch(() => undefined);
      throw error;
    } finally {
      client.release();
    }
  }

  async releaseScheduleRetry(
    taskId: string,
    claimOwner: string,
    nextAttemptAt: Date,
    message: string,
  ): Promise<void> {
    const result = await this.pool.query(
      `UPDATE provider_task SET internal_state='SCHEDULED', substate='scheduled',
       status_message=$2, schedule_claim_owner=NULL, schedule_claim_until=NULL,
       next_start_attempt_at=$4,
       version=version+1, updated_at=clock_timestamp()
       WHERE task_id=$1 AND internal_state='STARTING' AND schedule_claim_owner=$3`,
      [taskId, message, claimOwner, nextAttemptAt],
    );
    if (result.rowCount !== 1) throw new Error("SCHEDULED_TASK_CLAIM_LOST");
  }

  async markScheduleResponseUncertain(
    taskId: string,
    claimOwner: string,
    reconcileAt: Date,
    message: string,
  ): Promise<void> {
    const result = await this.pool.query(
      `UPDATE provider_task SET status_message=$2, schedule_claim_owner=NULL,
       schedule_claim_until=$4, version=version+1, updated_at=clock_timestamp()
       WHERE task_id=$1 AND internal_state='STARTING' AND schedule_claim_owner=$3`,
      [taskId, message, claimOwner, reconcileAt],
    );
    if (result.rowCount !== 1) throw new Error("SCHEDULED_TASK_CLAIM_LOST");
  }

  async deferScheduleReconcile(
    taskId: string,
    claimOwner: string,
    reconcileAt: Date,
    message: string,
  ): Promise<void> {
    return this.markScheduleResponseUncertain(taskId, claimOwner, reconcileAt, message);
  }

  async completeStartWindowMissed(
    taskId: string,
    completedAt: Date,
    claimOwner: string,
  ): Promise<TaskRecord> {
    const client = await this.pool.connect();
    try {
      await client.query("BEGIN");
      const result = await client.query<TaskRow>(
        `UPDATE provider_task SET internal_state='TERMINAL_COMPLETED', mcp_status='completed',
         substate=NULL, status_message='Start window was missed before execution began.',
         result=$2::jsonb, schedule_claim_owner=NULL, schedule_claim_until=NULL,
         next_start_attempt_at=NULL, version=version+1, updated_at=$3
         WHERE task_id=$1 AND external_execution_id IS NULL
           AND internal_state='STARTING' AND schedule_claim_owner=$4 RETURNING *`,
        [taskId, JSON.stringify(startWindowMissedResult(completedAt)), completedAt, claimOwner],
      );
      const row = result.rows[0];
      if (row === undefined) throw new Error("SCHEDULED_TASK_NOT_COMPLETED");
      const revision = await nextObservationRevision(client, taskId);
      await insertObservation(client, taskId, revision, startWindowMissedTransition(completedAt));
      await insertOutbox(client, taskId, "task.start_window_missed", {
        reasonCode: "START_WINDOW_MISSED",
        safeStopRequired: false,
      });
      await client.query("COMMIT");
      return fromRow(row);
    } catch (error) {
      await client.query("ROLLBACK").catch(() => undefined);
      throw error;
    } finally {
      client.release();
    }
  }

  async completeScheduledRejection(
    taskId: string,
    claimOwner: string,
    completedAt: Date,
    reasonCode: string,
    message: string,
    retryable: boolean,
  ): Promise<TaskRecord> {
    const client = await this.pool.connect();
    try {
      await client.query("BEGIN");
      const transition: SnapshotTransition = {
        internalState: "TERMINAL_COMPLETED",
        mcpStatus: "completed",
        substate: null,
        statusMessage: message,
        result: admissionRejectedResult(completedAt, reasonCode, message, retryable),
        error: null,
        terminal: true,
        observationType: "task.admission_rejected",
      };
      const result = await client.query<TaskRow>(
        `UPDATE provider_task SET internal_state='TERMINAL_COMPLETED', mcp_status='completed',
         substate=NULL, status_message=$3, result=$2::jsonb,
         schedule_claim_owner=NULL, schedule_claim_until=NULL, next_start_attempt_at=NULL,
         version=version+1, updated_at=$4
         WHERE task_id=$1 AND internal_state='STARTING' AND schedule_claim_owner=$5 RETURNING *`,
        [taskId, JSON.stringify(transition.result), message, completedAt, claimOwner],
      );
      const row = result.rows[0];
      if (row === undefined) throw new Error("SCHEDULED_REJECTION_NOT_COMPLETED");
      const revision = await nextObservationRevision(client, taskId);
      await insertObservation(client, taskId, revision, transition);
      await insertOutbox(client, taskId, "task.admission_rejected", { reasonCode, retryable });
      await client.query("COMMIT");
      return fromRow(row);
    } catch (error) {
      await client.query("ROLLBACK").catch(() => undefined);
      throw error;
    } finally {
      client.release();
    }
  }

  async requestStartWindowStop(taskId: string, requestedAt: Date): Promise<TaskRecord> {
    const client = await this.pool.connect();
    try {
      await client.query("BEGIN");
      const locked = await client.query<TaskRow>(
        "SELECT * FROM provider_task WHERE task_id=$1 FOR UPDATE",
        [taskId],
      );
      const row = locked.rows[0];
      if (row === undefined) throw new Error("TASK_NOT_FOUND");
      if (isTerminalState(row.internal_state)) {
        await client.query("COMMIT");
        return fromRow(row);
      }
      if (row.external_execution_id === null) {
        throw new Error("START_WINDOW_STOP_WITHOUT_EXECUTION");
      }
      await persistStartWindowStop(client, taskId, requestedAt);
      await client.query("COMMIT");
      const updated = await this.getById(taskId);
      if (updated === null) throw new Error("TASK_NOT_FOUND");
      return updated;
    } catch (error) {
      await client.query("ROLLBACK").catch(() => undefined);
      throw error;
    } finally {
      client.release();
    }
  }

  async claimOverdueImmediateStarts(now: Date, limit = 32): Promise<TaskRecord[]> {
    const client = await this.pool.connect();
    try {
      await client.query("BEGIN");
      const due = await client.query<TaskRow>(
        `SELECT * FROM provider_task
         WHERE internal_state NOT LIKE 'TERMINAL_%'
           AND actual_started_at IS NULL AND latest_start_at <= $1
           AND timing->'start'->>'mode'='immediate'
           AND external_execution_id IS NOT NULL
           AND stop_reason IS NULL
         ORDER BY latest_start_at, task_id
         FOR UPDATE SKIP LOCKED LIMIT $2`,
        [now, limit],
      );
      const claimed: TaskRecord[] = [];
      for (const row of due.rows) {
        await persistStartWindowStop(client, row.task_id, now);
        const updated = await client.query<TaskRow>(
          "SELECT * FROM provider_task WHERE task_id=$1",
          [row.task_id],
        );
        const updatedRow = updated.rows[0];
        if (updatedRow !== undefined) claimed.push(fromRow(updatedRow));
      }
      await client.query("COMMIT");
      return claimed;
    } catch (error) {
      await client.query("ROLLBACK").catch(() => undefined);
      throw error;
    } finally {
      client.release();
    }
  }

  async claimExpiredDeadlines(now: Date, limit = 32): Promise<DeadlineStopRecord[]> {
    const client = await this.pool.connect();
    try {
      await client.query("BEGIN");
      const expired = await client.query<TaskRow>(
        `SELECT * FROM provider_task
         WHERE deadline_at <= $1 AND stop_reason IS DISTINCT FROM 'DEADLINE_REACHED'
           AND external_execution_id IS NOT NULL
           AND internal_state NOT LIKE 'TERMINAL_%'
         ORDER BY deadline_at, task_id FOR UPDATE SKIP LOCKED LIMIT $2`,
        [now, limit],
      );
      const claimed: DeadlineStopRecord[] = [];
      for (const row of expired.rows) {
        const active = await client.query<{ command_sequence: string }>(
          `SELECT command_sequence FROM task_command
           WHERE task_id=$1 AND command_type='CANCEL'
             AND state IN ('PENDING','CLAIMED','RETRY_WAIT','ACKNOWLEDGED')
           ORDER BY command_sequence DESC LIMIT 1`,
          [row.task_id],
        );
        const activeSequence = active.rows[0]?.command_sequence;
        const updated = await client.query<TaskRow>(
          `UPDATE provider_task SET
             next_command_sequence=next_command_sequence + CASE WHEN $2::bigint IS NULL THEN 1 ELSE 0 END,
             internal_state='STOPPING', mcp_status='working', substate='stopping',
             status_message='Deadline reached; safe stop requested.', cancel_requested=true,
             stop_reason='DEADLINE_REACHED', version=version+1, updated_at=clock_timestamp()
           WHERE task_id=$1 RETURNING *`,
          [row.task_id, activeSequence ?? null],
        );
        const taskRow = updated.rows[0];
        if (taskRow === undefined) throw new Error("DEADLINE_CLAIM_LOST");
        const commandSequence = Number(activeSequence ?? taskRow.next_command_sequence);
        if (activeSequence === undefined) {
          await client.query(
            `INSERT INTO task_command
              (task_id, command_sequence, command_type, request_hash, state, payload,
               stop_reason, priority, previous_internal_state, previous_mcp_status,
               previous_substate, previous_status_message, next_attempt_at)
             VALUES ($1,$2,'CANCEL',$3,'PENDING',$4::jsonb,'DEADLINE_REACHED',100,$5,$6,$7,$8,$9)`,
            [
              taskRow.task_id,
              commandSequence,
              commandHash("DEADLINE_REACHED"),
              JSON.stringify({ reason: "DEADLINE_REACHED" }),
              row.internal_state,
              row.mcp_status,
              row.substate,
              row.status_message,
              now,
            ],
          );
        } else {
          await client.query(
            `UPDATE task_command SET stop_reason='DEADLINE_REACHED', priority=100,
               payload=$3::jsonb, updated_at=clock_timestamp()
             WHERE task_id=$1 AND command_sequence=$2`,
            [taskRow.task_id, commandSequence, JSON.stringify({ reason: "DEADLINE_REACHED" })],
          );
        }
        await insertOutbox(client, taskRow.task_id, "task.cancel_requested", {
          reason: "DEADLINE_REACHED",
        });
        claimed.push({ task: fromRow(taskRow), commandSequence });
      }
      await client.query("COMMIT");
      return claimed;
    } catch (error) {
      await client.query("ROLLBACK").catch(() => undefined);
      throw error;
    } finally {
      client.release();
    }
  }

  async listInputRequests(taskId: string): Promise<InputRequestRecord[]> {
    const result = await this.pool.query<{
      request_key: string;
      description: string;
      schema: Record<string, unknown>;
      required: boolean;
      status: "OPEN" | "ANSWERED";
      answer_hash: string | null;
    }>(
      `SELECT request_key, description, schema, required, status, answer_hash
       FROM task_input_request WHERE task_id=$1 ORDER BY created_at, request_key`,
      [taskId],
    );
    return result.rows.map((row) => ({
      key: row.request_key,
      description: row.description,
      schema: row.schema,
      required: row.required,
      status: row.status,
      answerHash: row.answer_hash,
    }));
  }

  async listObservations(taskId: string): Promise<ObservationRecord[]> {
    const result = await this.pool.query<{
      revision: string;
      type: string;
      occurred_at: Date;
      reason_code: string | null;
      payload: Record<string, unknown>;
    }>(
      `SELECT revision, type, occurred_at, reason_code, payload
       FROM task_observation WHERE task_id=$1 ORDER BY revision`,
      [taskId],
    );
    return result.rows.map((row) => ({
      revision: Number(row.revision),
      type: row.type,
      occurredAt: row.occurred_at,
      reasonCode: row.reason_code,
      payload: row.payload,
    }));
  }

  async beginCancel(
    taskId: string,
    requestHash: string,
  ): Promise<{ sequence: number; duplicate: boolean }> {
    const client = await this.pool.connect();
    try {
      await client.query("BEGIN");
      const locked = await client.query<TaskRow>(
        "SELECT * FROM provider_task WHERE task_id=$1 FOR UPDATE",
        [taskId],
      );
      const previous = locked.rows[0];
      if (previous === undefined) throw new Error("TASK_NOT_FOUND");
      const existing = await client.query<{ command_sequence: string }>(
        `SELECT command_sequence FROM task_command
         WHERE task_id=$1 AND command_type='CANCEL'
           AND state IN ('PENDING','CLAIMED','RETRY_WAIT','ACKNOWLEDGED')
         ORDER BY command_sequence LIMIT 1`,
        [taskId],
      );
      if (existing.rows[0] !== undefined) {
        await client.query("COMMIT");
        return { sequence: Number(existing.rows[0].command_sequence), duplicate: true };
      }
      const updated = await client.query<{ next_command_sequence: string }>(
        `UPDATE provider_task SET next_command_sequence=next_command_sequence+1,
           cancel_requested=true, stop_reason='USER_REQUESTED', internal_state='STOPPING',
           mcp_status='working', substate='stopping', status_message='Cancellation requested.',
           version=version+1, updated_at=clock_timestamp()
         WHERE task_id=$1 AND internal_state NOT LIKE 'TERMINAL_%'
         RETURNING next_command_sequence, internal_state, mcp_status, substate, status_message`,
        [taskId],
      );
      const sequence = updated.rows[0]?.next_command_sequence;
      if (sequence === undefined) throw new Error("TASK_ALREADY_TERMINAL");
      await client.query(
        `INSERT INTO task_command
          (task_id, command_sequence, command_type, request_hash, state, payload,
           stop_reason, priority, previous_internal_state, previous_mcp_status,
           previous_substate, previous_status_message)
         VALUES ($1,$2,'CANCEL',$3,'PENDING',$4::jsonb,'USER_REQUESTED',10,$5,$6,$7,$8)`,
        [
          taskId,
          sequence,
          requestHash,
          JSON.stringify({ reason: "USER_REQUESTED" }),
          previous.internal_state,
          previous.mcp_status,
          previous.substate,
          previous.status_message,
        ],
      );
      await insertOutbox(client, taskId, "task.cancel_requested", {});
      await client.query("COMMIT");
      return { sequence: Number(sequence), duplicate: false };
    } catch (error) {
      await client.query("ROLLBACK").catch(() => undefined);
      throw error;
    } finally {
      client.release();
    }
  }

  async beginCommand(
    taskId: string,
    commandType: "UPDATE" | "PAUSE" | "RESUME",
    requestHash: string,
    payload: Record<string, unknown>,
  ): Promise<{ sequence: number; duplicate: boolean }> {
    const client = await this.pool.connect();
    try {
      await client.query("BEGIN");
      const existing = await client.query<{ command_sequence: string }>(
        `SELECT command_sequence FROM task_command
         WHERE task_id=$1 AND command_type=$2 AND request_hash=$3`,
        [taskId, commandType, requestHash],
      );
      if (existing.rows[0] !== undefined) {
        await client.query("COMMIT");
        return { sequence: Number(existing.rows[0].command_sequence), duplicate: true };
      }
      const updated = await client.query<{ next_command_sequence: string }>(
        `UPDATE provider_task SET next_command_sequence=next_command_sequence+1,
           version=version+1, updated_at=clock_timestamp()
         WHERE task_id=$1 AND internal_state NOT LIKE 'TERMINAL_%'
         RETURNING next_command_sequence`,
        [taskId],
      );
      const sequence = updated.rows[0]?.next_command_sequence;
      if (sequence === undefined) throw new Error("TASK_ALREADY_TERMINAL");
      await client.query(
        `INSERT INTO task_command
          (task_id, command_sequence, command_type, request_hash, state, payload)
         VALUES ($1,$2,$3,$4,'PENDING',$5::jsonb)`,
        [taskId, sequence, commandType, requestHash, JSON.stringify(payload)],
      );
      await client.query("COMMIT");
      return { sequence: Number(sequence), duplicate: false };
    } catch (error) {
      await client.query("ROLLBACK").catch(() => undefined);
      throw error;
    } finally {
      client.release();
    }
  }

  async acknowledgeCommand(
    taskId: string,
    sequence: number,
    accepted: boolean,
    ack: Record<string, unknown>,
  ): Promise<void> {
    await this.pool.query(
      `UPDATE task_command SET state=$3, adapter_ack=$4::jsonb,
       updated_at=clock_timestamp() WHERE task_id=$1 AND command_sequence=$2`,
      [taskId, sequence, accepted ? "ACKNOWLEDGED" : "REJECTED", JSON.stringify(ack)],
    );
  }

  async acknowledgeClaimedCommand(
    command: PendingCommandRecord,
    ack: Record<string, unknown>,
  ): Promise<void> {
    const result = await this.pool.query(
      `UPDATE task_command SET state='ACKNOWLEDGED', adapter_ack=$4::jsonb,
         claim_owner=NULL, claim_until=NULL, last_error_code=NULL,
         last_error_message=NULL, updated_at=clock_timestamp()
       WHERE task_id=$1 AND command_sequence=$2 AND state='CLAIMED' AND claim_owner=$3`,
      [command.taskId, command.commandSequence, command.claimOwner, JSON.stringify(ack)],
    );
    if (result.rowCount !== 1) throw new Error("COMMAND_CLAIM_LOST");
  }

  async rejectUserCancel(
    command: PendingCommandRecord,
    adapterRevision: number,
    transition: SnapshotTransition,
    ack: Record<string, unknown>,
  ): Promise<TaskRecord> {
    const client = await this.pool.connect();
    try {
      await client.query("BEGIN");
      const locked = await client.query<TaskRow>(
        "SELECT * FROM provider_task WHERE task_id=$1 FOR UPDATE",
        [command.taskId],
      );
      const row = locked.rows[0];
      if (row === undefined) throw new Error("TASK_NOT_FOUND");
      if (isTerminalState(fromRow(row).internalState)) {
        await client.query(
          `UPDATE task_command SET state='EXHAUSTED', claim_owner=NULL, claim_until=NULL,
             last_error_code='TASK_TERMINAL', updated_at=clock_timestamp()
           WHERE task_id=$1 AND command_sequence=$2`,
          [command.taskId, command.commandSequence],
        );
        await client.query("COMMIT");
        return fromRow(row);
      }
      const updated = await client.query<TaskRow>(
        `UPDATE provider_task SET internal_state=$2, mcp_status=$3, substate=$4,
           status_message=$5, result=$6::jsonb, error=$7::jsonb,
           adapter_revision=GREATEST(adapter_revision,$8), cancel_requested=false,
           stop_reason=NULL, version=version+1, updated_at=clock_timestamp()
         WHERE task_id=$1 RETURNING *`,
        [
          command.taskId,
          transition.internalState,
          transition.mcpStatus,
          transition.substate,
          transition.statusMessage,
          jsonOrNull(transition.result),
          jsonOrNull(transition.error),
          adapterRevision,
        ],
      );
      const updatedRow = updated.rows[0];
      if (updatedRow === undefined) throw new Error("TASK_UPDATE_NOT_RETURNED");
      const revision = await nextObservationRevision(client, command.taskId);
      await insertObservation(client, command.taskId, revision, {
        ...transition,
        observationType: "task.cancel_rejected",
      });
      await insertOutbox(client, command.taskId, "task.cancel_rejected", {
        commandSequence: command.commandSequence,
      });
      await client.query(
        `UPDATE task_command SET state='REJECTED', adapter_ack=$4::jsonb,
           claim_owner=NULL, claim_until=NULL, last_error_code=$5,
           last_error_message=$6, updated_at=clock_timestamp()
         WHERE task_id=$1 AND command_sequence=$2 AND state='CLAIMED' AND claim_owner=$3`,
        [
          command.taskId,
          command.commandSequence,
          command.claimOwner,
          JSON.stringify(ack),
          typeof ack.reasonCode === "string" ? ack.reasonCode : "CANCEL_REJECTED",
          typeof ack.message === "string" ? ack.message : "Adapter rejected cancellation.",
        ],
      );
      await client.query("COMMIT");
      return fromRow(updatedRow);
    } catch (error) {
      await client.query("ROLLBACK").catch(() => undefined);
      throw error;
    } finally {
      client.release();
    }
  }

  async failSafeStopUnconfirmed(
    command: PendingCommandRecord,
    message: string,
  ): Promise<TaskRecord> {
    const client = await this.pool.connect();
    try {
      await client.query("BEGIN");
      const updated = await client.query<TaskRow>(
        `UPDATE provider_task SET internal_state='TERMINAL_FAILED', mcp_status='failed',
           substate=NULL, status_message=$2, result=NULL, error=$3::jsonb,
           version=version+1, updated_at=clock_timestamp()
         WHERE task_id=$1 AND internal_state NOT LIKE 'TERMINAL_%' RETURNING *`,
        [
          command.taskId,
          message,
          JSON.stringify({
            code: -32603,
            message,
            data: { reasonCode: "SAFE_STOP_UNCONFIRMED" },
          }),
        ],
      );
      const row = updated.rows[0];
      if (row === undefined) {
        const existing = await client.query<TaskRow>(
          "SELECT * FROM provider_task WHERE task_id=$1",
          [command.taskId],
        );
        const existingRow = existing.rows[0];
        if (existingRow === undefined) throw new Error("TASK_NOT_FOUND");
        await client.query(
          `UPDATE task_command SET state='EXHAUSTED', claim_owner=NULL, claim_until=NULL,
             last_error_code='TASK_TERMINAL', last_error_message=$4,
             updated_at=clock_timestamp()
           WHERE task_id=$1 AND command_sequence=$2 AND claim_owner=$3`,
          [command.taskId, command.commandSequence, command.claimOwner, message],
        );
        await client.query("COMMIT");
        return fromRow(existingRow);
      }
      const revision = await nextObservationRevision(client, command.taskId);
      await insertObservation(client, command.taskId, revision, {
        internalState: "TERMINAL_FAILED",
        mcpStatus: "failed",
        substate: null,
        statusMessage: message,
        result: null,
        error: row.error,
        terminal: true,
        observationType: "task.failed",
      });
      await insertOutbox(client, command.taskId, "task.safe_stop_unconfirmed", {
        reasonCode: "SAFE_STOP_UNCONFIRMED",
        stopReason: command.stopReason,
        severity: "critical",
      });
      await client.query(
        `UPDATE task_command SET state='EXHAUSTED', claim_owner=NULL, claim_until=NULL,
           last_error_code='SAFE_STOP_UNCONFIRMED', last_error_message=$4,
           updated_at=clock_timestamp()
         WHERE task_id=$1 AND command_sequence=$2 AND claim_owner=$3`,
        [command.taskId, command.commandSequence, command.claimOwner, message],
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

  async completeInputAnswers(
    taskId: string,
    answers: { key: string; hash: string; value: unknown }[],
  ): Promise<void> {
    const client = await this.pool.connect();
    try {
      await client.query("BEGIN");
      for (const answer of answers) {
        const result = await client.query(
          `UPDATE task_input_request SET status='ANSWERED', answer_hash=$3,
           answer=$4::jsonb, answered_at=clock_timestamp()
           WHERE task_id=$1 AND request_key=$2 AND status='OPEN'`,
          [taskId, answer.key, answer.hash, JSON.stringify(answer.value)],
        );
        if (result.rowCount !== 1) throw new Error("INPUT_REQUEST_NOT_OPEN");
      }
      await insertOutbox(client, taskId, "task.input_answered", {
        keys: answers.map((answer) => answer.key),
      });
      await client.query("COMMIT");
    } catch (error) {
      await client.query("ROLLBACK").catch(() => undefined);
      throw error;
    } finally {
      client.release();
    }
  }

  async applySnapshot(
    taskId: string,
    adapterRevision: number,
    transition: SnapshotTransition,
    inputRequests: {
      key: string;
      description: string;
      schema: Record<string, unknown>;
      required: boolean;
    }[] = [],
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
           actual_started_at=CASE WHEN $10 THEN COALESCE(actual_started_at,clock_timestamp())
                                  ELSE actual_started_at END,
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
          transitionHasStarted(transition),
        ],
      );
      if (updated.rowCount !== 1) throw new Error("TASK_VERSION_CONFLICT");
      await insertObservation(client, taskId, adapterRevision, transition);
      await upsertInputRequests(client, taskId, inputRequests);
      await insertOutbox(client, taskId, "task.updated", { status: transition.mcpStatus });
      if (transition.terminal) {
        await client.query(
          `UPDATE task_command SET state='EXHAUSTED', claim_owner=NULL, claim_until=NULL,
             last_error_code='TASK_TERMINAL', updated_at=clock_timestamp()
           WHERE task_id=$1 AND state IN ('PENDING','CLAIMED','RETRY_WAIT')`,
          [taskId],
        );
      }
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

async function persistStartWindowStop(
  client: PoolClient,
  taskId: string,
  requestedAt: Date,
): Promise<void> {
  const locked = await client.query<TaskRow>(
    "SELECT * FROM provider_task WHERE task_id=$1 FOR UPDATE",
    [taskId],
  );
  const previous = locked.rows[0];
  if (previous === undefined) throw new Error("TASK_NOT_FOUND");
  if (isTerminalState(previous.internal_state)) return;
  if (previous.external_execution_id === null)
    throw new Error("START_WINDOW_STOP_WITHOUT_EXECUTION");
  const active = await client.query<{ command_sequence: string; stop_reason: string | null }>(
    `SELECT command_sequence, stop_reason FROM task_command
     WHERE task_id=$1 AND command_type='CANCEL'
       AND state IN ('PENDING','CLAIMED','RETRY_WAIT','ACKNOWLEDGED')
     ORDER BY command_sequence DESC LIMIT 1`,
    [taskId],
  );
  const existing = active.rows[0];
  let commandSequence: number;
  if (existing === undefined) {
    const updated = await client.query<{ next_command_sequence: string }>(
      `UPDATE provider_task SET next_command_sequence=next_command_sequence+1,
       internal_state='STOPPING', mcp_status='working', substate='stopping',
       status_message='Start window missed; safe stop requested.', cancel_requested=true,
       stop_reason='START_WINDOW_MISSED', start_stop_requested_at=$2,
       schedule_claim_owner=NULL, schedule_claim_until=NULL, next_start_attempt_at=NULL,
       version=version+1, updated_at=$2 WHERE task_id=$1 RETURNING next_command_sequence`,
      [taskId, requestedAt],
    );
    commandSequence = Number(updated.rows[0]?.next_command_sequence);
    if (!Number.isSafeInteger(commandSequence))
      throw new Error("START_WINDOW_STOP_SEQUENCE_FAILED");
    await client.query(
      `INSERT INTO task_command
        (task_id, command_sequence, command_type, request_hash, state, payload,
         stop_reason, priority, previous_internal_state, previous_mcp_status,
         previous_substate, previous_status_message, next_attempt_at)
       VALUES ($1,$2,'CANCEL',$3,'PENDING',$4::jsonb,'START_WINDOW_MISSED',200,
               $5,$6,$7,$8,$9)`,
      [
        taskId,
        commandSequence,
        commandHash("START_WINDOW_MISSED"),
        JSON.stringify({ reason: "START_WINDOW_MISSED" }),
        previous.internal_state,
        previous.mcp_status,
        previous.substate,
        previous.status_message,
        requestedAt,
      ],
    );
  } else {
    commandSequence = Number(existing.command_sequence);
    if (existing.stop_reason === "USER_REQUESTED") {
      await client.query(
        `UPDATE task_command SET stop_reason='START_WINDOW_MISSED', priority=200,
         payload=$3::jsonb, updated_at=$4 WHERE task_id=$1 AND command_sequence=$2`,
        [taskId, commandSequence, JSON.stringify({ reason: "START_WINDOW_MISSED" }), requestedAt],
      );
      await client.query(
        `UPDATE provider_task SET stop_reason='START_WINDOW_MISSED',
         start_stop_requested_at=$2, status_message='Start window missed; safe stop requested.',
         version=version+1, updated_at=$2 WHERE task_id=$1`,
        [taskId, requestedAt],
      );
    }
  }
  const revision = await nextObservationRevision(client, taskId);
  await insertObservation(client, taskId, revision, {
    internalState: "STOPPING",
    mcpStatus: "working",
    substate: "stopping",
    statusMessage: "Start window missed; safe stop requested.",
    result: null,
    error: null,
    terminal: false,
    observationType: "task.start_window_violation",
  });
  await insertOutbox(client, taskId, "task.start_window_stop_requested", {
    reasonCode: "START_WINDOW_MISSED",
    commandSequence,
  });
}

function transitionHasStarted(transition: SnapshotTransition): boolean {
  return ["RUNNING", "PAUSED", "RESUMING", "TERMINAL_COMPLETED", "TERMINAL_FAILED"].includes(
    transition.internalState,
  );
}

function startWindowMissedResult(completedAt: Date): Record<string, unknown> {
  return {
    content: [{ type: "text", text: "Start window was missed before execution began." }],
    isError: true,
    structuredContent: {
      outcome: "start_window_missed",
      reasonCode: "START_WINDOW_MISSED",
      retryable: true,
      completedAt: completedAt.toISOString(),
    },
  };
}

function startWindowMissedTransition(completedAt: Date): SnapshotTransition {
  return {
    internalState: "TERMINAL_COMPLETED",
    mcpStatus: "completed",
    substate: null,
    statusMessage: "Start window was missed before execution began.",
    result: startWindowMissedResult(completedAt),
    error: null,
    terminal: true,
    observationType: "task.start_window_missed",
  };
}

function admissionRejectedResult(
  completedAt: Date,
  reasonCode: string,
  message: string,
  retryable: boolean,
): Record<string, unknown> {
  return {
    content: [{ type: "text", text: message }],
    isError: true,
    structuredContent: {
      outcome: "admission_rejected",
      reasonCode,
      retryable,
      completedAt: completedAt.toISOString(),
    },
  };
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

async function nextObservationRevision(client: PoolClient, taskId: string): Promise<number> {
  const result = await client.query<{ revision: string }>(
    `SELECT COALESCE(max(revision),0)+1 AS revision
     FROM task_observation WHERE task_id=$1`,
    [taskId],
  );
  return Number(result.rows[0]?.revision ?? 1);
}

async function upsertInputRequests(
  client: PoolClient,
  taskId: string,
  inputRequests: {
    key: string;
    description: string;
    schema: Record<string, unknown>;
    required: boolean;
  }[],
): Promise<void> {
  for (const input of inputRequests) {
    const result = await client.query(
      `INSERT INTO task_input_request
        (task_id, request_key, description, schema, required, status)
       VALUES ($1,$2,$3,$4::jsonb,$5,'OPEN')
       ON CONFLICT (task_id, request_key) DO UPDATE SET
         description=EXCLUDED.description
       WHERE task_input_request.schema=EXCLUDED.schema
         AND task_input_request.required=EXCLUDED.required
       RETURNING request_key`,
      [taskId, input.key, input.description, JSON.stringify(input.schema), input.required],
    );
    if (result.rowCount !== 1) throw new Error("STABLE_INPUT_REQUEST_CONFLICT");
  }
}

function commandHash(reason: string): string {
  return createHash("sha256").update(`cancel:${reason.toLowerCase()}`).digest("hex");
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
    actualStartedAt: row.actual_started_at,
    startStopRequestedAt: row.start_stop_requested_at,
    invocationAttempt: row.invocation_attempt,
    nextStartAttemptAt: row.next_start_attempt_at,
    scheduleClaimOwner: row.schedule_claim_owner,
    scheduleClaimUntil: row.schedule_claim_until,
    deadlineAt: row.deadline_at,
    cancelRequested: row.cancel_requested,
    stopReason: row.stop_reason,
    timing: row.timing,
    recoveryAttempts: row.recovery_attempts,
    lastReconciledAt: row.last_reconciled_at,
  };
}
