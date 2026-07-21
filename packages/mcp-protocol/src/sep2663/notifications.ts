import { randomUUID } from "node:crypto";
import type { ServerResponse } from "node:http";
import type { AuthorizationContext } from "../../../domain/src/index.js";
import { isRuntimeError } from "../../../domain/src/index.js";
import type { TaskEngine } from "../../../task-engine/src/index.js";
import { invalidParams } from "./errors.js";
import type { FrozenJsonRpcRequest } from "./request-validator.js";

export interface TaskNotificationStreamOptions {
  pollIntervalMs?: number;
}

export interface SubscriptionIdentity {
  internalId: string;
  transportScopeId: string;
  wireRequestId: string | number;
  typedWireRequestKey: string;
  authorizationScope: string;
}

export class TaskNotificationWriter {
  constructor(readonly response: ServerResponse) {}

  write(message: Record<string, unknown>): boolean {
    const accepted = this.response.write(`event: message\ndata: ${JSON.stringify(message)}\n\n`);
    if (!accepted) this.response.end();
    return accepted;
  }
}

export class TaskNotificationSubscription {
  readonly cancellation = new AbortController();
  readonly revisions = new Map<string, NotificationState>();
  readonly writer: TaskNotificationWriter;
  acceptedTaskIds: string[] = [];

  constructor(
    readonly identity: SubscriptionIdentity,
    readonly authorization: AuthorizationContext,
    readonly response: ServerResponse,
  ) {
    this.writer = new TaskNotificationWriter(response);
  }
}

export class TaskNotificationManager {
  readonly #pollIntervalMs: number;
  readonly #subscriptions = new Map<string, TaskNotificationSubscription>();
  readonly #transportWireIndex = new Map<string, Set<string>>();

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
    transportScopeId = "direct",
  ): Promise<void> {
    const identity = subscriptionIdentity(request.id, transportScopeId, authorization);
    const transportKey = transportWireIndexKey(identity);
    const existing = this.#transportWireIndex.get(transportKey);
    if (
      existing !== undefined &&
      [...existing].some(
        (internalId) =>
          this.#subscriptions.get(internalId)?.identity.authorizationScope ===
          identity.authorizationScope,
      )
    ) {
      throw invalidParams();
    }
    const subscription = new TaskNotificationSubscription(identity, authorization, response);
    this.#subscriptions.set(identity.internalId, subscription);
    const indexed = existing ?? new Set<string>();
    indexed.add(identity.internalId);
    this.#transportWireIndex.set(transportKey, indexed);
    try {
      const requestedTaskIds = parseTaskIds(request.params);
      const current = new Map<string, Record<string, unknown>>();
      for (const taskId of requestedTaskIds) {
        const snapshot = await this.#authorizedSnapshot(taskId, authorization);
        if (snapshot !== undefined) current.set(taskId, snapshot);
      }
      subscription.acceptedTaskIds = [...current.keys()].sort();

      response.statusCode = 200;
      response.setHeader("content-type", "text/event-stream");
      response.setHeader("cache-control", "no-cache, no-transform");
      response.setHeader("connection", "keep-alive");
      response.flushHeaders();

      if (!subscription.writer.write(acknowledged(request.id, subscription.acceptedTaskIds))) {
        return;
      }
      for (const taskId of subscription.acceptedTaskIds) {
        const snapshot = current.get(taskId);
        if (snapshot === undefined) continue;
        const revision = runtimeRevision(snapshot);
        subscription.revisions.set(taskId, notificationState(snapshot, revision));
        if (!subscription.writer.write(taskNotification(request.id, snapshot))) return;
      }
      if (subscription.acceptedTaskIds.length === 0) {
        response.end();
        return;
      }

      await this.#waitForSubscription(subscription);
    } finally {
      this.#release(subscription);
    }
  }

  cancel(
    requestId: string | number,
    transportScopeId = "direct",
    authorization?: AuthorizationContext,
  ): boolean {
    const key = transportWireIndexKey({
      transportScopeId,
      typedWireRequestKey: typedWireRequestKey(requestId),
    });
    const candidates = [...(this.#transportWireIndex.get(key) ?? [])]
      .map((internalId) => this.#subscriptions.get(internalId))
      .filter((candidate): candidate is TaskNotificationSubscription => candidate !== undefined)
      .filter(
        (candidate) =>
          authorization === undefined ||
          candidate.identity.authorizationScope === authorizationScope(authorization),
      );
    if (candidates.length !== 1) return false;
    candidates[0]?.cancellation.abort();
    return true;
  }

  handleCancelledNotification(
    value: unknown,
    transportScopeId = "direct",
    authorization?: AuthorizationContext,
  ): boolean {
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
    return this.cancel(record.requestId as string | number, transportScopeId, authorization);
  }

  async #waitForSubscription(subscription: TaskNotificationSubscription): Promise<void> {
    await new Promise<void>((resolve) => {
      let polling = false;
      let closed = false;
      const close = (): void => {
        if (closed) return;
        closed = true;
        clearInterval(timer);
        subscription.cancellation.signal.removeEventListener("abort", cancel);
        resolve();
      };
      const cancel = (): void => {
        subscription.response.end();
        close();
      };
      const timer = setInterval(() => {
        if (polling || closed) return;
        polling = true;
        void this.#poll(subscription)
          .then((keepOpen) => {
            if (!keepOpen) {
              subscription.response.end();
              close();
            }
          })
          .catch(() => {
            subscription.response.end();
            close();
          })
          .finally(() => {
            polling = false;
          });
      }, this.#pollIntervalMs);
      timer.unref();
      subscription.response.once("close", close);
      subscription.response.once("error", close);
      subscription.cancellation.signal.addEventListener("abort", cancel, { once: true });
    });
  }

  async #poll(subscription: TaskNotificationSubscription): Promise<boolean> {
    for (const taskId of subscription.acceptedTaskIds) {
      const snapshot = await this.#authorizedSnapshot(taskId, subscription.authorization);
      if (snapshot === undefined) continue;
      const revision = runtimeRevision(snapshot);
      const previous = subscription.revisions.get(taskId);
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
      subscription.revisions.set(taskId, next);
      if (
        !subscription.writer.write(taskNotification(subscription.identity.wireRequestId, snapshot))
      ) {
        return false;
      }
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

  #release(subscription: TaskNotificationSubscription): void {
    this.#subscriptions.delete(subscription.identity.internalId);
    const key = transportWireIndexKey(subscription.identity);
    const indexed = this.#transportWireIndex.get(key);
    indexed?.delete(subscription.identity.internalId);
    if (indexed?.size === 0) this.#transportWireIndex.delete(key);
  }
}

export class TaskNotificationStream extends TaskNotificationManager {}

interface NotificationState {
  revision: string;
  signature: string;
  terminal: boolean;
}

function subscriptionIdentity(
  wireRequestId: string | number,
  transportScopeId: string,
  authorization: AuthorizationContext,
): SubscriptionIdentity {
  return {
    internalId: randomUUID(),
    transportScopeId,
    wireRequestId,
    typedWireRequestKey: typedWireRequestKey(wireRequestId),
    authorizationScope: authorizationScope(authorization),
  };
}

function typedWireRequestKey(requestId: string | number): string {
  return `${typeof requestId}:${String(requestId)}`;
}

function authorizationScope(authorization: AuthorizationContext): string {
  return [authorization.hash, authorization.executionMode, authorization.simulationId ?? ""].join(
    ":",
  );
}

function transportWireIndexKey(
  identity: Pick<SubscriptionIdentity, "transportScopeId" | "typedWireRequestKey">,
): string {
  return `${identity.transportScopeId}\u0000${identity.typedWireRequestKey}`;
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
  const meta =
    typeof snapshot._meta === "object" && snapshot._meta !== null && !Array.isArray(snapshot._meta)
      ? (snapshot._meta as Record<string, unknown>)
      : {};
  return {
    jsonrpc: "2.0",
    method: "notifications/tasks",
    params: {
      ...snapshot,
      _meta: {
        ...meta,
        "io.modelcontextprotocol/subscriptionId": subscriptionId,
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
