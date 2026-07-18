import type { ServerResponse } from "node:http";
import type { AuthorizationContext } from "../../../domain/src/index.js";
import { isRuntimeError } from "../../../domain/src/index.js";
import type { TaskEngine } from "../../../task-engine/src/index.js";
import { invalidParams } from "./errors.js";
import type { FrozenJsonRpcRequest } from "./request-validator.js";

export interface TaskNotificationStreamOptions {
  pollIntervalMs?: number;
}

export class TaskNotificationStream {
  readonly #pollIntervalMs: number;
  readonly #subscriptions = new Map<string, AbortController>();

  constructor(
    readonly taskEngine: Pick<TaskEngine, "getFrozenTask">,
    options: TaskNotificationStreamOptions = {},
  ) {
    this.#pollIntervalMs = options.pollIntervalMs ?? 250;
  }

  async listen(
    request: FrozenJsonRpcRequest,
    response: ServerResponse,
    authorization: AuthorizationContext,
  ): Promise<void> {
    const subscriptionId = String(request.id);
    if (this.#subscriptions.has(subscriptionId)) throw invalidParams();
    const cancellation = new AbortController();
    this.#subscriptions.set(subscriptionId, cancellation);
    const requestedTaskIds = parseTaskIds(request.params);
    const current = new Map<string, Record<string, unknown>>();
    for (const taskId of requestedTaskIds) {
      const snapshot = await this.#authorizedSnapshot(taskId, authorization);
      if (snapshot !== undefined) current.set(taskId, snapshot);
    }
    const acceptedTaskIds = [...current.keys()].sort();

    response.statusCode = 200;
    response.setHeader("content-type", "text/event-stream");
    response.setHeader("cache-control", "no-cache, no-transform");
    response.setHeader("connection", "keep-alive");
    response.flushHeaders();

    if (!writeFrame(response, acknowledged(request.id, acceptedTaskIds))) {
      this.#subscriptions.delete(subscriptionId);
      return;
    }
    const revisions = new Map<string, NotificationState>();
    for (const taskId of acceptedTaskIds) {
      const snapshot = current.get(taskId);
      if (snapshot === undefined) continue;
      const revision = runtimeRevision(snapshot);
      revisions.set(taskId, notificationState(snapshot, revision));
      if (!writeFrame(response, taskNotification(request.id, snapshot))) {
        this.#subscriptions.delete(subscriptionId);
        return;
      }
    }
    if (acceptedTaskIds.length === 0) {
      this.#subscriptions.delete(subscriptionId);
      response.end();
      return;
    }

    await new Promise<void>((resolve) => {
      let polling = false;
      let closed = false;
      const close = (): void => {
        if (closed) return;
        closed = true;
        clearInterval(timer);
        cancellation.signal.removeEventListener("abort", cancel);
        this.#subscriptions.delete(subscriptionId);
        resolve();
      };
      const cancel = (): void => {
        response.end();
        close();
      };
      const timer = setInterval(() => {
        if (polling || closed) return;
        polling = true;
        void this.#poll(request.id, acceptedTaskIds, revisions, response, authorization)
          .then((keepOpen) => {
            if (!keepOpen) {
              response.end();
              close();
            }
          })
          .catch(() => {
            response.end();
            close();
          })
          .finally(() => {
            polling = false;
          });
      }, this.#pollIntervalMs);
      timer.unref();
      response.once("close", close);
      response.once("error", close);
      cancellation.signal.addEventListener("abort", cancel, { once: true });
    });
  }

  cancel(requestId: string | number): boolean {
    const subscription = this.#subscriptions.get(String(requestId));
    if (subscription === undefined) return false;
    subscription.abort();
    return true;
  }

  handleCancelledNotification(value: unknown): boolean {
    if (typeof value !== "object" || value === null || Array.isArray(value)) {
      throw invalidParams();
    }
    const notification = value as Record<string, unknown>;
    if (notification.jsonrpc !== "2.0" || notification.method !== "notifications/cancelled") {
      throw invalidParams();
    }
    const params = notification.params;
    if (typeof params !== "object" || params === null || Array.isArray(params)) {
      throw invalidParams();
    }
    const record = params as Record<string, unknown>;
    if (
      Object.keys(record).length !== 1 ||
      (typeof record.requestId !== "string" && !Number.isInteger(record.requestId))
    ) {
      throw invalidParams();
    }
    return this.cancel(record.requestId as string | number);
  }

  async #poll(
    subscriptionId: string | number,
    taskIds: readonly string[],
    revisions: Map<string, NotificationState>,
    response: ServerResponse,
    authorization: AuthorizationContext,
  ): Promise<boolean> {
    for (const taskId of taskIds) {
      const snapshot = await this.#authorizedSnapshot(taskId, authorization);
      if (snapshot === undefined) continue;
      const revision = runtimeRevision(snapshot);
      const previous = revisions.get(taskId);
      if (previous !== undefined && BigInt(revision) < BigInt(previous.revision)) {
        throw new Error("TASK_NOTIFICATION_REVISION_REGRESSION");
      }
      const next = notificationState(snapshot, revision);
      if (previous?.revision === revision) {
        if (previous.signature !== next.signature) {
          throw new Error("TASK_NOTIFICATION_REVISION_CONFLICT");
        }
        continue;
      }
      if (previous?.terminal === true && !next.terminal) {
        throw new Error("TASK_NOTIFICATION_TERMINAL_REGRESSION");
      }
      revisions.set(taskId, next);
      if (!writeFrame(response, taskNotification(subscriptionId, snapshot))) return false;
    }
    return true;
  }

  async #authorizedSnapshot(
    taskId: string,
    authorization: AuthorizationContext,
  ): Promise<Record<string, unknown> | undefined> {
    try {
      return await this.taskEngine.getFrozenTask(taskId, authorization, "notification");
    } catch (error) {
      if (
        isRuntimeError(error) &&
        (error.kind === "task_not_found" || error.kind === "task_expired")
      ) {
        return undefined;
      }
      throw error;
    }
  }
}

interface NotificationState {
  revision: string;
  signature: string;
  terminal: boolean;
}

function notificationState(snapshot: Record<string, unknown>, revision: string): NotificationState {
  return {
    revision,
    signature: JSON.stringify(snapshot),
    terminal: new Set(["completed", "failed", "cancelled"]).has(String(snapshot.status)),
  };
}

function parseTaskIds(params: Record<string, unknown>): string[] {
  if (Object.keys(params).some((key) => key !== "notifications" && key !== "_meta")) {
    throw invalidParams();
  }
  const notifications = params.notifications;
  if (notifications === null || typeof notifications !== "object" || Array.isArray(notifications)) {
    throw invalidParams();
  }
  const record = notifications as Record<string, unknown>;
  if (Object.keys(record).some((key) => key !== "taskIds")) throw invalidParams();
  const taskIds = record.taskIds;
  if (!Array.isArray(taskIds) || taskIds.length > 256) throw invalidParams();
  if (taskIds.some((taskId) => typeof taskId !== "string" || taskId.length === 0)) {
    throw invalidParams();
  }
  return [...new Set(taskIds as string[])].sort();
}

function acknowledged(subscriptionId: string | number, taskIds: string[]): Record<string, unknown> {
  return {
    jsonrpc: "2.0",
    method: "notifications/subscriptions/acknowledged",
    params: {
      _meta: { "io.modelcontextprotocol/subscriptionId": subscriptionId },
      notifications: { taskIds },
    },
  };
}

function taskNotification(
  subscriptionId: string | number,
  snapshot: Record<string, unknown>,
): Record<string, unknown> {
  const meta = snapshot._meta as Record<string, Record<string, unknown>>;
  const execution = meta["io.sdar/taskExecution"] ?? {};
  const revision = String(execution.runtimeRevision);
  const taskId = String(snapshot.taskId);
  return {
    jsonrpc: "2.0",
    method: "notifications/tasks",
    params: {
      ...snapshot,
      _meta: {
        ...meta,
        "io.modelcontextprotocol/subscriptionId": subscriptionId,
        "io.sdar/taskExecution": {
          ...execution,
          eventId: `${taskId}:${revision}`,
          observedAt: snapshot.lastUpdatedAt,
        },
      },
    },
  };
}

function runtimeRevision(snapshot: Record<string, unknown>): string {
  const meta = snapshot._meta as Record<string, Record<string, unknown>> | undefined;
  const revision = meta?.["io.sdar/taskExecution"]?.runtimeRevision;
  if (typeof revision !== "string" || !/^(0|[1-9][0-9]{0,19})$/.test(revision)) {
    throw new Error("TASK_NOTIFICATION_REVISION_INVALID");
  }
  return revision;
}

function writeFrame(response: ServerResponse, message: Record<string, unknown>): boolean {
  const accepted = response.write(`event: message\ndata: ${JSON.stringify(message)}\n\n`);
  if (!accepted) response.end();
  return accepted;
}
