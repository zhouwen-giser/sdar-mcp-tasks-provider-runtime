import type { IncomingHttpHeaders, IncomingMessage, ServerResponse } from "node:http";
import type { ValidatedManifest } from "../../../operation-registry/src/index.js";
import { frozenDiscoveryResult } from "./discovery.js";
import { FrozenErrorCode, FrozenProtocolError, frozenErrorResponse } from "./errors.js";
import { validateFrozenHeaders } from "./headers.js";
import { validateFrozenRequest } from "./request-validator.js";

export interface FrozenDispatchResult {
  httpStatus: number;
  body: Record<string, unknown>;
}

export class Sep2663ProtocolHandler {
  constructor(
    readonly manifest: ValidatedManifest,
    readonly serverVersion = "2.0.0-rc.1",
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

  handle(request: IncomingMessage, response: ServerResponse, body: unknown): void {
    const dispatched = this.dispatch(body, request.headers);
    const serialized = JSON.stringify(dispatched.body);
    response.statusCode = dispatched.httpStatus;
    response.setHeader("content-type", "application/json");
    response.setHeader("content-length", String(Buffer.byteLength(serialized)));
    response.end(serialized);
  }
}

function requestId(value: unknown): string | number | null {
  if (typeof value !== "object" || value === null || Array.isArray(value)) return null;
  const id = (value as Record<string, unknown>).id;
  return typeof id === "string" || (typeof id === "number" && Number.isInteger(id)) ? id : null;
}
