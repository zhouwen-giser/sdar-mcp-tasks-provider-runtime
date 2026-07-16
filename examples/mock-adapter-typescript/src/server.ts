import * as grpc from "@grpc/grpc-js";
import {
  adapterServiceDefinition,
  ADAPTER_PROTOCOL_VERSION,
  jsonToProtoStruct,
  protoStructToJson,
} from "../../../packages/adapter-protocol/src/index.js";

export interface MockAdapterOptions {
  providerId?: string;
  providerVersion?: string;
}

function notFound(message: string): grpc.ServiceError {
  return Object.assign(new Error(message), { code: grpc.status.NOT_FOUND }) as grpc.ServiceError;
}

export function createMockAdapterServer(options: MockAdapterOptions = {}): grpc.Server {
  const providerId = options.providerId ?? "mock-provider";
  const providerVersion = options.providerVersion ?? "1.0.0";
  const server = new grpc.Server();
  const executions = new Map<
    string,
    {
      externalExecutionId: string;
      argumentHash: string;
      snapshot: Record<string, unknown>;
      terminalSnapshot: Record<string, unknown>;
    }
  >();

  server.addService(adapterServiceDefinition(), {
    describeProvider: (
      _call: grpc.ServerUnaryCall<unknown, unknown>,
      callback: grpc.sendUnaryData<unknown>,
    ) => {
      callback(null, {
        adapterProtocolVersion: ADAPTER_PROTOCOL_VERSION,
        providerId,
        providerType: "reference",
        providerVersion,
        inventoryMode: "RUNTIME_VISIBLE",
        operations: [
          {
            name: "echo_sync",
            description: "Returns the supplied message synchronously.",
            execution: "SYNCHRONOUS",
            inputSchema: jsonToProtoStruct({
              type: "object",
              properties: { message: { type: "string" } },
              required: ["message"],
              additionalProperties: false,
            }),
            outputSchema: jsonToProtoStruct({
              type: "object",
              properties: { message: { type: "string" } },
              required: ["message"],
              additionalProperties: false,
            }),
            capabilities: {
              availability: true,
              scheduling: false,
              maxElapsed: false,
              cancel: false,
              pauseResume: false,
              inputRequired: false,
              idempotency: true,
              observations: false,
            },
            resourceBinding: { mode: "NONE" },
          },
          {
            name: "durable_task",
            description: "Reference long-running task used by conformance scenarios.",
            execution: "TASK_REQUIRED",
            inputSchema: jsonToProtoStruct({
              type: "object",
              properties: {
                resourceId: { type: "string" },
                scenario: { type: "string" },
              },
              required: ["resourceId"],
              additionalProperties: false,
            }),
            outputSchema: jsonToProtoStruct({ type: "object" }),
            capabilities: {
              availability: true,
              scheduling: true,
              maxElapsed: true,
              cancel: true,
              pauseResume: true,
              inputRequired: true,
              idempotency: true,
              observations: true,
            },
            resourceBinding: {
              mode: "ARGUMENT_REFERENCE",
              resourceIdJsonPointer: "/resourceId",
            },
          },
          {
            name: "flex_task",
            description: "Completes inline or continues as a task according to the scenario.",
            execution: "TASK_CAPABLE",
            inputSchema: jsonToProtoStruct({
              type: "object",
              properties: {
                resourceId: { type: "string" },
                scenario: { type: "string", enum: ["terminal", "running"] },
              },
              required: ["resourceId", "scenario"],
              additionalProperties: false,
            }),
            outputSchema: jsonToProtoStruct({ type: "object" }),
            capabilities: {
              availability: true,
              scheduling: false,
              maxElapsed: false,
              cancel: false,
              pauseResume: false,
              inputRequired: false,
              idempotency: true,
              observations: true,
            },
            resourceBinding: {
              mode: "ARGUMENT_REFERENCE",
              resourceIdJsonPointer: "/resourceId",
            },
          },
        ],
      });
    },
    getExecution: (
      call: grpc.ServerUnaryCall<{ taskId?: string }, unknown>,
      callback: grpc.sendUnaryData<unknown>,
    ) => {
      const taskId = call.request.taskId ?? "";
      const execution = executions.get(taskId);
      if (execution === undefined) {
        callback(notFound(`Execution ${taskId || "<missing>"} does not exist`));
        return;
      }
      execution.snapshot = execution.terminalSnapshot;
      callback(null, execution.snapshot);
    },
    startOperation: (
      call: grpc.ServerUnaryCall<
        {
          taskId?: string;
          operationName?: string;
          arguments?: unknown;
          argumentHash?: string;
        },
        unknown
      >,
      callback: grpc.sendUnaryData<unknown>,
    ) => {
      const taskId = call.request.taskId ?? "missing";
      const existing = executions.get(taskId);
      if (existing !== undefined) {
        if (existing.argumentHash !== (call.request.argumentHash ?? "")) {
          callback(
            Object.assign(new Error("taskId argument conflict"), {
              code: grpc.status.ALREADY_EXISTS,
            }),
          );
          return;
        }
        callback(null, {
          accepted: {
            externalExecutionId: existing.externalExecutionId,
            initialSnapshot: existing.snapshot,
          },
          result: "accepted",
        });
        return;
      }
      if (
        call.request.operationName !== "echo_sync" &&
        call.request.operationName !== "durable_task" &&
        call.request.operationName !== "flex_task"
      ) {
        callback(null, {
          rejected: {
            reasonCode: "UNSUPPORTED_R1_SCENARIO",
            message: "Unknown reference operation.",
            retryable: false,
          },
          result: "rejected",
        });
        return;
      }
      const result = protoStructToJson(call.request.arguments);
      const now = new Date();
      if (call.request.operationName === "flex_task" && result.scenario === "terminal") {
        callback(null, {
          accepted: {
            externalExecutionId: `inline-${taskId}`,
            initialSnapshot: {
              taskId,
              externalExecutionId: `inline-${taskId}`,
              state: "SUCCEEDED",
              revision: "1",
              reasonCode: "SUCCESS",
              message: "Task-capable operation completed inline.",
              result: jsonToProtoStruct({ resourceId: result.resourceId, completed: true }),
              observedAt: { seconds: String(Math.floor(now.getTime() / 1000)), nanos: 0 },
            },
          },
          result: "accepted",
        });
        return;
      }
      if (
        call.request.operationName === "durable_task" ||
        call.request.operationName === "flex_task"
      ) {
        const externalExecutionId = `task-${taskId}`;
        const initialSnapshot = {
          taskId,
          externalExecutionId,
          state: "RUNNING",
          revision: "1",
          reasonCode: "STARTED",
          message: "Reference task is running.",
          retryable: false,
          observedAt: { seconds: String(Math.floor(now.getTime() / 1000)), nanos: 0 },
        };
        const terminalSnapshot = {
          ...initialSnapshot,
          state: "SUCCEEDED",
          revision: "2",
          reasonCode: "SUCCESS",
          message: "Reference task completed.",
          result: jsonToProtoStruct({ resourceId: result.resourceId, completed: true }),
        };
        executions.set(taskId, {
          externalExecutionId,
          argumentHash: call.request.argumentHash ?? "",
          snapshot: initialSnapshot,
          terminalSnapshot,
        });
        callback(null, {
          accepted: { externalExecutionId, initialSnapshot },
          result: "accepted",
        });
        return;
      }
      callback(null, {
        accepted: {
          externalExecutionId: `sync-${taskId}`,
          initialSnapshot: {
            taskId,
            externalExecutionId: `sync-${taskId}`,
            state: "SUCCEEDED",
            revision: "1",
            reasonCode: "SUCCESS",
            message: "Synchronous echo completed.",
            result: jsonToProtoStruct(result),
            observedAt: { seconds: String(Math.floor(now.getTime() / 1000)), nanos: 0 },
          },
        },
        result: "accepted",
      });
    },
  });

  return server;
}

export function bindMockAdapter(server: grpc.Server, address: string): Promise<number> {
  return new Promise<number>((resolve, reject) => {
    server.bindAsync(address, grpc.ServerCredentials.createInsecure(), (error, port) => {
      if (error === null) resolve(port);
      else reject(error);
    });
  });
}
