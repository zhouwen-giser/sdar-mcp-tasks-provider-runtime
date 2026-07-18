import type { LightExecutionEngine } from "./execution-engine.js";
import type { ExecutionStore } from "./execution-store.js";

export class ConfirmationWorker {
  #timer: NodeJS.Timeout | undefined;
  constructor(
    readonly store: ExecutionStore,
    readonly engine: LightExecutionEngine,
    readonly intervalMs: number,
  ) {}
  start(): void {
    if (this.#timer !== undefined) return;
    this.#timer = setInterval(() => {
      for (const execution of this.store.list())
        if (execution.state === "CONFIRMING") void this.engine.poll(execution.taskId);
    }, this.intervalMs);
  }
  stop(): void {
    if (this.#timer !== undefined) clearInterval(this.#timer);
    this.#timer = undefined;
  }
}
