import type { IncomingHttpHeaders, IncomingMessage, ServerResponse } from "node:http";
import type { ValidatedManifest } from "../../../operation-registry/src/index.js";
import type { AuthorizationContext } from "../../../domain/src/index.js";
import { isRuntimeError } from "../../../domain/src/index.js";
import type { TaskEngine } from "../../../task-engine/src/index.js";
import { createAuthorizationResolver, type AuthorizationResolver } from "../security.js";
import { frozenDiscoveryResult } from "./discovery.js";
import { FrozenErrorCode, FrozenProtocolError, frozenErrorResponse } from "./errors.js";
import { validateFrozenHeaders } from "./headers.js";
import { validateFrozenRequest } from "./request-validator.js";
import { requireTasksCapability } from "./request-validator.js";
import { parseTaskId, parseTaskInputResponses, parseTaskReference } from "./tasks.js";

const developmentAuthorization = createAuthorizationResolver({ mode: "development" });

export interface FrozenDispatchResult {
  httpStatus: number;
  body: Record<string, unknown>;
}

export class Sep2663ProtocolHandler {
  constructor(
    readonly manifest: ValidatedManifest,
    readonly serverVersion = "2.0.0-rc.1",
    readonly taskEngine?: TaskEngine,
    readonly resolveAuthorization: AuthorizationResolver = developmentAuthorization,
  ) {}

  dispatch(body: unknown, headers: IncomingHttpHeaders): FrozenDispatchResult {
    const id = requestId(body);
    try {
      const request = validateFrozenRequest(body);
      validateFrozenHeaders(headers, request);
      let result: Record<string, unknown>;
      switch (request.method) {
        case "server/discover":
          result = frozenDiscoveryResult(this.serverVersion);
          break;
        case "tools/list":
          result = {
            resultType: "complete",
            tools: this.manifest.operations.map((operation) => operation.tool),
          };
          break;
        default:
          throw new FrozenProtocolError(FrozenErrorCode.MethodNotFound, "Method not found", 404);
      }
      return {
        httpStatus: 200,
        body: { jsonrpc: "2.0", id: request.id, result },
      };
    } catch (error) {
      const mapped =
        error instanceof FrozenProtocolError
          ? error
          : new FrozenProtocolError(FrozenErrorCode.InternalError, "Internal error", 500);
      return { httpStatus: mapped.httpStatus, body: frozenErrorResponse(id, mapped) };
    }
  }

  async dispatchAsync(
    body: unknown,
    headers: IncomingHttpHeaders,
    authorization: AuthorizationContext,
  ): Promise<FrozenDispatchResult> {
    const id = requestId(body);
    try {
      const request = validateFrozenRequest(body);
      validateFrozenHeaders(headers, request);
      if (request.method === "server/discover" || request.method === "tools/list") {
        return this.dispatch(body, headers);
      }
      if (this.taskEngine === undefined) {
        throw new FrozenProtocolError(FrozenErrorCode.MethodNotFound, "Method not found", 404);
      }
      requireTasksCapability(request);
      let result: Record<string, unknown>;
      switch (request.method) {
        case "tasks/get": {
          const taskId = parseTaskReference(request.params);
          result = await this.taskEngine.getFrozenTask(taskId, authorization, "get");
          break;
        }
        case "tasks/update": {
          const taskId = parseTaskId(request.params);
          const inputResponses = parseTaskInputResponses(request.params);
          await this.taskEngine.updateTaskInputResponses(taskId, inputResponses, authorization);
          result = { resultType: "complete" };
          break;
        }
        case "tasks/cancel": {
          const taskId = parseTaskReference(request.params);
          await this.taskEngine.cancelTaskCooperatively(taskId, authorization);
          result = { resultType: "complete" };
          break;
        }
        default:
          throw new FrozenProtocolError(FrozenErrorCode.MethodNotFound, "Method not found", 404);
      }
      return { httpStatus: 200, body: { jsonrpc: "2.0", id: request.id, result } };
    } catch (error) {
      const mapped = mapFrozenError(error);
      return { httpStatus: mapped.httpStatus, body: frozenErrorResponse(id, mapped) };
    }
  }

  async handle(request: IncomingMessage, response: ServerResponse, body: unknown): Promise<void> {
    let dispatched: FrozenDispatchResult;
    try {
      const authorization = this.resolveAuthorization(request);
      dispatched = await this.dispatchAsync(body, request.headers, authorization);
    } catch (error) {
      const mapped = mapFrozenError(error);
      dispatched = {
        httpStatus: mapped.httpStatus,
        body: frozenErrorResponse(requestId(body), mapped),
      };
    }
    const serialized = JSON.stringify(dispatched.body);
    response.statusCode = dispatched.httpStatus;
    response.setHeader("content-type", "application/json");
    response.setHeader("content-length", String(Buffer.byteLength(serialized)));
    response.end(serialized);
  }
}

function mapFrozenError(error: unknown): FrozenProtocolError {
  if (error instanceof FrozenProtocolError) return error;
  if (isRuntimeError(error)) {
    return new FrozenProtocolError(FrozenErrorCode.InvalidParams, error.safeMessage, 400, {
      reasonCode: error.reasonCode,
    });
  }
  return new FrozenProtocolError(FrozenErrorCode.InternalError, "Internal error", 500);
}

function requestId(value: unknown): string | number | null {
  if (typeof value !== "object" || value === null || Array.isArray(value)) return null;
  const id = (value as Record<string, unknown>).id;
  return typeof id === "string" || (typeof id === "number" && Number.isInteger(id)) ? id : null;
}
