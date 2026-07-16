import { Server } from "@modelcontextprotocol/sdk/server/index.js";
import { StreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/streamableHttp.js";
import type { Transport } from "@modelcontextprotocol/sdk/shared/transport.js";
import {
  CallToolRequestSchema,
  CancelTaskRequestSchema,
  ErrorCode,
  GetTaskPayloadRequestSchema,
  GetTaskRequestSchema,
  ListToolsRequestSchema,
  McpError,
  RequestSchema,
} from "@modelcontextprotocol/sdk/types.js";
import type { IncomingMessage, ServerResponse } from "node:http";
import { protoStructToJson } from "../../adapter-protocol/src/index.js";
import type { GrpcAdapterGateway } from "../../adapter-protocol/src/index.js";
import type { ValidatedManifest } from "../../operation-registry/src/index.js";
import type { AvailabilityCheck, TaskExecutionTiming } from "../../domain/src/index.js";
import { TaskExpiredError } from "../../domain/src/index.js";
import type { TaskEngine } from "../../task-engine/src/index.js";
import { z } from "zod";
import { createAuthorizationResolver } from "./security.js";
import type { AuthorizationResolver } from "./security.js";

const developmentAuthorization = createAuthorizationResolver({ mode: "development" });

export interface McpProtocolOptions {
  resolveAuthorization?: AuthorizationResolver;
  maxArgumentBytes?: number;
  maxJsonDepth?: number;
  maxJsonNodes?: number;
}

const AvailabilityCheckSchema = z.object({
  requestId: z.string().min(1).max(256),
  operationName: z.string().min(1).max(64),
  arguments: z.union([
    z.record(z.string(), z.unknown()),
    z.object({
      unresolved: z.literal(true),
      knownArguments: z.record(z.string(), z.unknown()),
      unresolvedPaths: z.array(z.string()).max(256),
    }),
  ]),
  timing: z
    .object({
      start: z
        .object({
          mode: z.enum(["immediate", "scheduled"]),
          scheduledAt: z.string().optional(),
          startToleranceMs: z.number().int().nonnegative().optional(),
        })
        .optional(),
      maxElapsedMs: z.number().int().positive().nullable().optional(),
    })
    .optional(),
});

const CheckAvailabilityRequestSchema = RequestSchema.extend({
  method: z.literal("io.sdar/taskExecution/checkAvailability"),
  params: z.object({ checks: z.array(AvailabilityCheckSchema).min(1).max(128) }),
});

const TaskTimingSchema = z.object({
  start: z.discriminatedUnion("mode", [
    z.object({ mode: z.literal("immediate"), startToleranceMs: z.number().int().nonnegative() }),
    z.object({
      mode: z.literal("scheduled"),
      scheduledAt: z.string(),
      startToleranceMs: z.number().int().nonnegative(),
    }),
  ]),
  maxElapsedMs: z.number().int().positive().nullable(),
});

const UpdateTaskRequestSchema = RequestSchema.extend({
  method: z.literal("tasks/update"),
  params: z.object({
    taskId: z.uuid(),
    inputs: z.record(z.string().min(1).max(256), z.unknown()),
  }),
});

const ControlTaskRequestSchema = (
  method: "io.sdar/taskExecution/tasks/pause" | "io.sdar/taskExecution/tasks/resume",
) =>
  RequestSchema.extend({
    method: z.literal(method),
    params: z.object({ taskId: z.uuid() }),
  });

export class McpProtocolHandler {
  constructor(
    readonly manifest: ValidatedManifest,
    readonly gateway: GrpcAdapterGateway,
    readonly taskEngine?: TaskEngine,
    readonly options: McpProtocolOptions = {},
  ) {}

  async handle(request: IncomingMessage, response: ServerResponse, body: unknown): Promise<void> {
    const authorization = (this.options.resolveAuthorization ?? developmentAuthorization)(request);
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
      tasks: { cancel: {}, requests: { tools: { call: {} } } },
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
      assertJsonLimits(
        argumentsValue,
        this.options.maxArgumentBytes ?? 1_048_576,
        this.options.maxJsonDepth ?? 32,
        this.options.maxJsonNodes ?? 10_000,
      );
      operation.validateArguments(argumentsValue);
      if (this.taskEngine !== undefined) {
        const invocation = await this.taskEngine.callOperation(
          operation,
          argumentsValue,
          authorization,
          params.task?.ttl,
          idempotencyKey(params._meta),
          taskTiming(params._meta),
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
        CheckAvailabilityRequestSchema,
        ({ params }) =>
          taskEngine.checkAvailability(
            params.checks as AvailabilityCheck[],
            authorization,
          ) as never,
      );
      server.setRequestHandler(GetTaskRequestSchema, async ({ params }) => {
        try {
          return await taskEngine.getTask(params.taskId, authorization);
        } catch (error) {
          throw mapTaskReadError(error);
        }
      });
      server.setRequestHandler(GetTaskPayloadRequestSchema, async ({ params }) => {
        try {
          return await taskEngine.getTaskResult(params.taskId, authorization);
        } catch (error) {
          throw mapTaskReadError(error);
        }
      });
      server.setRequestHandler(CancelTaskRequestSchema, async ({ params }) => {
        try {
          return await taskEngine.cancelTask(params.taskId, authorization);
        } catch (error) {
          throw mapTaskReadError(error);
        }
      });
      server.setRequestHandler(UpdateTaskRequestSchema, async ({ params }) => {
        assertJsonLimits(
          params.inputs,
          this.options.maxArgumentBytes ?? 1_048_576,
          this.options.maxJsonDepth ?? 32,
          this.options.maxJsonNodes ?? 10_000,
        );
        try {
          return await taskEngine.updateTask(params.taskId, params.inputs, authorization);
        } catch (error) {
          throw mapTaskReadError(error);
        }
      });
      server.setRequestHandler(
        ControlTaskRequestSchema("io.sdar/taskExecution/tasks/pause"),
        async ({ params }) => {
          try {
            return await taskEngine.controlTask(params.taskId, "PAUSE", authorization);
          } catch (error) {
            throw mapTaskReadError(error);
          }
        },
      );
      server.setRequestHandler(
        ControlTaskRequestSchema("io.sdar/taskExecution/tasks/resume"),
        async ({ params }) => {
          try {
            return await taskEngine.controlTask(params.taskId, "RESUME", authorization);
          } catch (error) {
            throw mapTaskReadError(error);
          }
        },
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

function mapTaskReadError(error: unknown): unknown {
  if (error instanceof TaskExpiredError) {
    return new McpError(ErrorCode.InvalidParams, "Task handle expired.", {
      reasonCode: "TASK_EXPIRED",
    });
  }
  return error;
}

function idempotencyKey(meta: unknown): string | undefined {
  const profile = profileMetadata(meta);
  if (profile === undefined) return undefined;
  const key = profile.idempotencyKey;
  if (key === undefined) return undefined;
  if (typeof key !== "string") throw new Error("INVALID_IDEMPOTENCY_KEY");
  return key;
}

function taskTiming(meta: unknown): TaskExecutionTiming | undefined {
  const timing = profileMetadata(meta)?.timing;
  if (timing === undefined) return undefined;
  return TaskTimingSchema.parse(timing);
}

function profileMetadata(meta: unknown): Record<string, unknown> | undefined {
  if (typeof meta !== "object" || meta === null) return undefined;
  const profile = (meta as Record<string, unknown>)["io.sdar/taskExecution"];
  if (typeof profile !== "object" || profile === null) return undefined;
  return profile as Record<string, unknown>;
}

export function assertJsonLimits(
  value: unknown,
  maxBytes: number,
  maxDepth: number,
  maxNodes: number,
): void {
  if (Buffer.byteLength(JSON.stringify(value)) > maxBytes) throw new Error("ARGUMENTS_TOO_LARGE");
  let nodes = 0;
  const visit = (item: unknown, depth: number): void => {
    nodes += 1;
    if (nodes > maxNodes) throw new Error("ARGUMENTS_TOO_COMPLEX");
    if (depth > maxDepth) throw new Error("ARGUMENTS_TOO_DEEP");
    if (Array.isArray(item)) {
      for (const child of item) visit(child, depth + 1);
    } else if (typeof item === "object" && item !== null) {
      for (const child of Object.values(item)) visit(child, depth + 1);
    }
  };
  visit(value, 0);
}
