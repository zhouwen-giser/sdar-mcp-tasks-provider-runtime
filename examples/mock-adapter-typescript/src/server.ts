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
        ],
      });
    },
    getExecution: (
      call: grpc.ServerUnaryCall<{ taskId?: string }, unknown>,
      callback: grpc.sendUnaryData<unknown>,
    ) => {
      callback(notFound(`Execution ${call.request.taskId ?? "<missing>"} does not exist`));
    },
    startOperation: (
      call: grpc.ServerUnaryCall<
        {
          taskId?: string;
          operationName?: string;
          arguments?: unknown;
        },
        unknown
      >,
      callback: grpc.sendUnaryData<unknown>,
    ) => {
      if (call.request.operationName !== "echo_sync") {
        callback(null, {
          rejected: {
            reasonCode: "UNSUPPORTED_R1_SCENARIO",
            message: "R1 only executes echo_sync.",
            retryable: false,
          },
          result: "rejected",
        });
        return;
      }
      const result = protoStructToJson(call.request.arguments);
      const now = new Date();
      callback(null, {
        accepted: {
          externalExecutionId: `sync-${call.request.taskId ?? "missing"}`,
          initialSnapshot: {
            taskId: call.request.taskId,
            externalExecutionId: `sync-${call.request.taskId ?? "missing"}`,
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
