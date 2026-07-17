import type {
  ResolvedTaskOperation,
  TaskRepository,
} from "../../persistence-postgres/src/index.js";
import type { TaskEngine } from "./engine.js";

export interface RecoveryScanResult {
  admissionsRecovered: number;
  tasksReconciled: number;
  notFound: number;
  deferred: number;
  lockSkipped: number;
}

export class RecoveryManager {
  constructor(
    readonly engine: TaskEngine,
    readonly repository: TaskRepository,
    readonly recoveryLeaseMs = 30_000,
    readonly onTaskError: (error: unknown, taskId: string) => void = () => undefined,
  ) {}

  async scan(): Promise<RecoveryScanResult> {
    const result: RecoveryScanResult = {
      admissionsRecovered: 0,
      tasksReconciled: 0,
      notFound: 0,
      deferred: 0,
      lockSkipped: 0,
    };

    const admissions = await this.repository.listAdmissionsForRecovery();
    for (const admission of admissions) {
      try {
        const recovered = await this.repository.withRecoveryLock(
          admission.taskId,
          async () => {
            const resolvedOperation: ResolvedTaskOperation = await this.engine.resolveTaskOperation(
              admission.operationSnapshotId,
            );
            await this.engine.recoverAdmission(admission, resolvedOperation.operation);
            return true;
          },
          this.recoveryLeaseMs,
        );
        if (recovered === null) result.lockSkipped += 1;
        else result.admissionsRecovered += 1;
      } catch (error) {
        result.deferred += 1;
        this.onTaskError(error, admission.taskId);
      }
    }

    const tasks = await this.repository.listTasksForRecovery();
    for (const candidate of tasks) {
      try {
        const outcome = await this.repository.withRecoveryLock(
          candidate.taskId,
          async () => {
          const task = await this.repository.getById(candidate.taskId);
          if (task === null || task.internalState.startsWith("TERMINAL_")) return "terminal";
          const resolvedOperation: ResolvedTaskOperation = await this.engine.resolveTaskOperation(
            task.operationSnapshotId,
          );
          return this.engine.reconcileTask(task, resolvedOperation.operation);
        },
          this.recoveryLeaseMs,
        );
        if (outcome === null) result.lockSkipped += 1;
        else if (outcome === "found") result.tasksReconciled += 1;
        else if (outcome === "not_found") result.notFound += 1;
        else if (outcome === "deferred") result.deferred += 1;
      } catch (error) {
        result.deferred += 1;
        this.onTaskError(error, candidate.taskId);
      }
    }
    return result;
  }
}
