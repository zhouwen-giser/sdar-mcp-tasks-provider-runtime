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
  onStartSideEffect?: (taskId: string) => void;
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
    checkAvailability: (
      call: grpc.ServerUnaryCall<
        { checks?: { requestId?: string; operationName?: string; arguments?: unknown }[] },
        unknown
      >,
      callback: grpc.sendUnaryData<unknown>,
    ) => {
      const checkedAt = new Date();
      const validUntil = new Date(checkedAt.getTime() + 10_000);
      callback(null, {
        profileVersion: "1.0",
        checkedAt: timestamp(checkedAt),
        checks: (call.request.checks ?? []).map((check) => {
          const argumentsValue = protoStructToJson(check.arguments);
          if (argumentsValue.scenario === "restricted") {
            return {
              requestId: check.requestId,
              operationName: check.operationName,
              availability: "RESTRICTED",
              riskLevel: "HIGH",
              reasonCode: "PREEMPTIBLE_TASK_ACTIVE",
              description: "The resource may require preemption.",
              validUntil: timestamp(validUntil),
              earliestStartTime: timestamp(validUntil),
              nextAvailableWindows: [
                {
                  startTime: timestamp(validUntil),
                  endTime: timestamp(new Date(validUntil.getTime() + 60_000)),
                },
              ],
              estimatedDelayMs: "10000",
              possibleEffects: ["task_preemption", "start_rejection"],
            };
          }
          if (argumentsValue.scenario === "disabled") {
            return {
              requestId: check.requestId,
              operationName: check.operationName,
              availability: "DISABLED",
              riskLevel: "LOW",
              reasonCode: "RESOURCE_DISABLED",
              description: "The resource is disabled.",
            };
          }
          return {
            requestId: check.requestId,
            operationName: check.operationName,
            availability: "AVAILABLE",
            riskLevel: "LOW",
            reasonCode: "AVAILABLE",
            description: "The operation is currently predicted to be available.",
            validUntil: timestamp(validUntil),
          };
        }),
      });
    },
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
    reconcileExecution: (
      call: grpc.ServerUnaryCall<{ taskId?: string; argumentHash?: string }, unknown>,
      callback: grpc.sendUnaryData<unknown>,
    ) => {
      const execution = executions.get(call.request.taskId ?? "");
      if (execution === undefined) {
        callback(null, {
          status: "NOT_FOUND",
          reasonCode: "EXECUTION_NOT_FOUND",
          message: "No execution is bound to this taskId.",
          retryable: false,
        });
        return;
      }
      if (execution.argumentHash !== (call.request.argumentHash ?? "")) {
        callback(null, {
          status: "CONFLICT",
          reasonCode: "ARGUMENT_HASH_CONFLICT",
          message: "The taskId is bound to different arguments.",
          retryable: false,
        });
        return;
      }
      callback(null, {
        status: "FOUND",
        snapshot: execution.snapshot,
        externalExecutionId: execution.externalExecutionId,
        reasonCode: "EXECUTION_FOUND",
        message: "Execution recovered.",
        retryable: false,
      });
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
      options.onStartSideEffect?.(taskId);
      if (call.request.operationName === "flex_task" && result.scenario === "terminal") {
        const externalExecutionId = `inline-${taskId}`;
        const terminalSnapshot = {
          taskId,
          externalExecutionId,
          state: "SUCCEEDED",
          revision: "1",
          reasonCode: "SUCCESS",
          message: "Task-capable operation completed inline.",
          result: jsonToProtoStruct({ resourceId: result.resourceId, completed: true }),
          observedAt: timestamp(now),
        };
        executions.set(taskId, {
          externalExecutionId,
          argumentHash: call.request.argumentHash ?? "",
          snapshot: terminalSnapshot,
          terminalSnapshot,
        });
        callback(null, {
          accepted: { externalExecutionId, initialSnapshot: terminalSnapshot },
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
        if (result.scenario === "response_loss") {
          callback(
            Object.assign(new Error("injected StartOperation response loss"), {
              code: grpc.status.UNAVAILABLE,
            }),
          );
          return;
        }
        callback(null, {
          accepted: { externalExecutionId, initialSnapshot },
          result: "accepted",
        });
        return;
      }
      const externalExecutionId = `sync-${taskId}`;
      const terminalSnapshot = {
        taskId,
        externalExecutionId,
        state: "SUCCEEDED",
        revision: "1",
        reasonCode: "SUCCESS",
        message: "Synchronous echo completed.",
        result: jsonToProtoStruct(result),
        observedAt: timestamp(now),
      };
      executions.set(taskId, {
        externalExecutionId,
        argumentHash: call.request.argumentHash ?? "",
        snapshot: terminalSnapshot,
        terminalSnapshot,
      });
      callback(null, {
        accepted: { externalExecutionId, initialSnapshot: terminalSnapshot },
        result: "accepted",
      });
    },
  });

  return server;
}

function timestamp(value: Date): { seconds: string; nanos: number } {
  return { seconds: String(Math.floor(value.getTime() / 1000)), nanos: 0 };
}

export function bindMockAdapter(server: grpc.Server, address: string): Promise<number> {
  return new Promise<number>((resolve, reject) => {
    server.bindAsync(address, grpc.ServerCredentials.createInsecure(), (error, port) => {
      if (error === null) resolve(port);
      else reject(error);
    });
  });
}
