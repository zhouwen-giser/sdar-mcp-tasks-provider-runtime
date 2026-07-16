import { Server } from "@modelcontextprotocol/sdk/server/index.js";
import { StreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/streamableHttp.js";
import type { Transport } from "@modelcontextprotocol/sdk/shared/transport.js";
import {
  CallToolRequestSchema,
  GetTaskRequestSchema,
  ListToolsRequestSchema,
} from "@modelcontextprotocol/sdk/types.js";
import { createHash } from "node:crypto";
import type { IncomingMessage, ServerResponse } from "node:http";
import { protoStructToJson } from "../../adapter-protocol/src/index.js";
import type { GrpcAdapterGateway } from "../../adapter-protocol/src/index.js";
import type { ValidatedManifest } from "../../operation-registry/src/index.js";
import type { AuthorizationContext, ExecutionMode } from "../../domain/src/index.js";
import type { TaskEngine } from "../../task-engine/src/index.js";

export class McpProtocolHandler {
  constructor(
    readonly manifest: ValidatedManifest,
    readonly gateway: GrpcAdapterGateway,
    readonly taskEngine?: TaskEngine,
  ) {}

  async handle(request: IncomingMessage, response: ServerResponse, body: unknown): Promise<void> {
    const authorization = authorizationFromRequest(request);
    const profileCapability = {
      version: "1.0",
      availability: this.manifest.operations.some(
        (operation) => operation.capabilities.availability,
      ),
      scheduling: this.manifest.operations.some((operation) => operation.capabilities.scheduling),
      observations: this.manifest.operations.some(
        (operation) => operation.capabilities.observations,
      ),
      idempotency: this.manifest.operations.some((operation) => operation.capabilities.idempotency),
    };
    const capabilities = {
      tools: {},
      tasks: { requests: { tools: { call: {} } } },
      experimental: {
        "io.modelcontextprotocol/tasks": {},
        "io.sdar/taskExecution": profileCapability,
      },
      extensions: {
        "io.modelcontextprotocol/tasks": {},
        "io.sdar/taskExecution": profileCapability,
      },
    };
    // The low-level SDK server is intentional: Adapter JSON Schemas are already
    // validated Draft 2020-12 documents, not Zod schemas owned by the Runtime.
    // eslint-disable-next-line @typescript-eslint/no-deprecated
    const server = new Server(
      { name: "sdar-mcp-tasks-provider-runtime", version: "1.0.0-rc.1" },
      {
        capabilities,
      },
    );
    server.setRequestHandler(ListToolsRequestSchema, () => ({
      tools: this.manifest.operations.map((operation) => operation.tool),
    }));
    server.setRequestHandler(CallToolRequestSchema, async ({ params }) => {
      const operation = this.manifest.operations.find(
        (candidate) => candidate.name === params.name,
      );
      if (operation === undefined) throw new Error("UNKNOWN_TOOL");
      const argumentsValue = params.arguments ?? {};
      operation.validateArguments(argumentsValue);
      if (this.taskEngine !== undefined) {
        const invocation = await this.taskEngine.callOperation(
          operation,
          argumentsValue,
          authorization,
          params.task?.ttl,
        );
        return invocation.kind === "result" ? invocation.result : { task: invocation.task };
      }
      const start = await this.gateway.startOperation(operation.name, argumentsValue);
      if (start.result === "rejected" || start.rejected !== undefined) {
        const rejected = start.rejected;
        return {
          content: [{ type: "text", text: rejected?.message ?? "Operation rejected." }],
          isError: true,
          structuredContent: {
            outcome: "admission_rejected",
            reasonCode: rejected?.reasonCode ?? "ADMISSION_REJECTED",
            retryable: rejected?.retryable ?? false,
            completedAt: new Date().toISOString(),
          },
        };
      }
      const snapshot = start.accepted?.initialSnapshot;
      if (snapshot?.state !== "SUCCEEDED")
        throw new Error("R2_NONTERMINAL_EXECUTION_REQUIRES_TASK_ENGINE");
      const result = protoStructToJson(snapshot.result);
      return {
        content: [{ type: "text", text: snapshot.message || "Operation completed." }],
        isError: false,
        structuredContent: result,
      };
    });
    const taskEngine = this.taskEngine;
    if (taskEngine !== undefined) {
      server.setRequestHandler(
        GetTaskRequestSchema,
        ({ params }) => taskEngine.getTask(params.taskId, authorization) as never,
      );
    }

    const transport = new StreamableHTTPServerTransport();
    await server.connect(transport as unknown as Transport);
    response.once("close", () => {
      void transport.close();
      void server.close();
    });
    await transport.handleRequest(request, response, body);
  }
}

function authorizationFromRequest(request: IncomingMessage): AuthorizationContext {
  const subject = header(request, "x-sdar-subject") ?? "development-anonymous";
  const tenant = header(request, "x-sdar-tenant") ?? "default";
  const modeHeader = header(request, "x-sdar-execution-mode") ?? "live";
  if (!isExecutionMode(modeHeader)) throw new Error("INVALID_EXECUTION_MODE");
  const simulationId = header(request, "x-sdar-simulation-id") ?? null;
  if ((modeHeader === "live") !== (simulationId === null)) {
    throw new Error("INVALID_SIMULATION_CONTEXT");
  }
  return {
    hash: createHash("sha256").update(`${tenant}\u0000${subject}`).digest("hex"),
    executionMode: modeHeader,
    simulationId,
  };
}

function header(request: IncomingMessage, name: string): string | undefined {
  const value = request.headers[name];
  return Array.isArray(value) ? value[0] : value;
}

function isExecutionMode(value: string): value is ExecutionMode {
  return value === "live" || value === "simulation" || value === "historical-replay";
}
