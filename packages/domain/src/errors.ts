export class TaskExpiredError extends Error {
  readonly code = "TASK_EXPIRED";

  constructor() {
    super("TASK_EXPIRED");
    this.name = "TaskExpiredError";
  }
}
