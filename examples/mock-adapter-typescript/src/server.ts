import * as grpc from "@grpc/grpc-js";
import { adapterServiceDefinition } from "../../../packages/adapter-protocol/src/index.js";
import { ADAPTER_PROTOCOL_VERSION } from "../../../packages/adapter-protocol/src/index.js";
import { jsonToStruct } from "./struct.js";

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
            inputSchema: jsonToStruct({
              type: "object",
              properties: { message: { type: "string" } },
              required: ["message"],
              additionalProperties: false,
            }),
            outputSchema: jsonToStruct({
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
            inputSchema: jsonToStruct({
              type: "object",
              properties: {
                resourceId: { type: "string" },
                scenario: { type: "string" },
              },
              required: ["resourceId"],
              additionalProperties: false,
            }),
            outputSchema: jsonToStruct({ type: "object" }),
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
