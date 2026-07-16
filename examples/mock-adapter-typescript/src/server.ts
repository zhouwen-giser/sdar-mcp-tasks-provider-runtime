import * as grpc from "@grpc/grpc-js";
import {
  adapterServiceDefinition,
  ADAPTER_PROTOCOL_VERSION,
  jsonToProtoStruct,
  protoStructToJson,
} from "../../../packages/adapter-protocol/src/index.js";
import { JsonFileStore } from "./store.js";

export interface MockAdapterOptions {
  providerId?: string;
  providerVersion?: string;
  onStartSideEffect?: (taskId: string) => void;
  onControlSideEffect?: (taskId: string, command: string) => void;
  statePath?: string;
}

interface MockExecution {
  externalExecutionId: string;
  argumentHash: string;
  snapshot: Record<string, unknown>;
  terminalSnapshot: Record<string, unknown>;
  waitingForInput?: boolean;
  scenario?: string;
  holdSnapshot?: boolean;
  holdReads?: number;
  inputRound?: number;
  cancelAttempts?: number;
  commandAcks: Record<string, Record<string, unknown>>;
}

function notFound(message: string): grpc.ServiceError {
  return Object.assign(new Error(message), { code: grpc.status.NOT_FOUND }) as grpc.ServiceError;
}

export function createMockAdapterServer(options: MockAdapterOptions = {}): grpc.Server {
  const providerId = options.providerId ?? "mock-provider";
  const providerVersion = options.providerVersion ?? "1.0.0";
  const server = new grpc.Server();
  const executions = new JsonFileStore<MockExecution>(
    options.statePath ?? process.env.ADAPTER_STATE_PATH,
  );

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
      if ((execution.holdReads ?? 0) > 0) {
        execution.holdReads = (execution.holdReads ?? 1) - 1;
      } else if (!execution.waitingForInput && !execution.holdSnapshot) {
        execution.snapshot = execution.terminalSnapshot;
      }
      executions.set(taskId, execution);
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
    requestCancel: (
      call: grpc.ServerUnaryCall<
        { identity?: { taskId?: string; commandSequence?: string | number } },
        unknown
      >,
      callback: grpc.sendUnaryData<unknown>,
    ) => {
      const taskId = call.request.identity?.taskId ?? "";
      const execution = executions.get(taskId);
      if (execution === undefined) {
        callback(null, {
          accepted: false,
          reasonCode: "EXECUTION_NOT_FOUND",
          message: "Execution does not exist.",
          commandSequence: call.request.identity?.commandSequence ?? "0",
        });
        return;
      }
      const commandKey = `cancel:${String(call.request.identity?.commandSequence ?? "0")}`;
      const existingAck = execution.commandAcks[commandKey];
      if (existingAck !== undefined) {
        callback(null, existingAck);
        return;
      }
      execution.cancelAttempts = (execution.cancelAttempts ?? 0) + 1;
      if (execution.scenario === "cancel_permanent_reject") {
        executions.set(taskId, execution);
        callback(null, {
          accepted: false,
          reasonCode: "CANCEL_NOT_PERMITTED",
          message: "Reference execution rejected user cancellation.",
          commandSequence: call.request.identity?.commandSequence ?? "1",
        });
        return;
      }
      if (execution.scenario === "cancel_retryable_reject" && execution.cancelAttempts === 1) {
        executions.set(taskId, execution);
        callback(null, {
          accepted: false,
          reasonCode: "TRANSIENT_UNAVAILABLE",
          message: "Reference execution requests a retry.",
          commandSequence: call.request.identity?.commandSequence ?? "1",
        });
        return;
      }
      if (execution.scenario === "cancel_transport_failure") {
        executions.set(taskId, execution);
        callback(
          Object.assign(new Error("injected cancel transport failure"), {
            code: grpc.status.UNAVAILABLE,
          }),
        );
        return;
      }
      options.onControlSideEffect?.(taskId, "cancel");
      execution.snapshot =
        execution.scenario === "natural_completion"
          ? execution.terminalSnapshot
          : {
              ...execution.snapshot,
              state: "CANCELLED",
              revision: String(Number(execution.snapshot.revision ?? 1) + 1),
              reasonCode: "SAFE_STOP_CONFIRMED",
              message: "Reference execution safely stopped.",
              observedAt: timestamp(new Date()),
            };
      execution.terminalSnapshot = execution.snapshot;
      const ack = {
        accepted: true,
        reasonCode: "STOP_ACCEPTED",
        message: "Safe stop accepted.",
        commandSequence: call.request.identity?.commandSequence ?? "1",
      };
      execution.commandAcks[commandKey] = ack;
      executions.set(taskId, execution);
      if (execution.scenario === "cancel_response_loss") {
        callback(
          Object.assign(new Error("injected RequestCancel response loss"), {
            code: grpc.status.UNAVAILABLE,
          }),
        );
        return;
      }
      callback(null, ack);
    },
    updateExecution: (
      call: grpc.ServerUnaryCall<
        {
          identity?: { taskId?: string; commandSequence?: string | number };
          inputs?: { inputRequestKey?: string }[];
        },
        unknown
      >,
      callback: grpc.sendUnaryData<unknown>,
    ) => {
      const taskId = call.request.identity?.taskId ?? "";
      const execution = executions.get(taskId);
      const commandKey = `update:${String(call.request.identity?.commandSequence ?? "0")}`;
      const existingAck = execution?.commandAcks[commandKey];
      if (existingAck !== undefined) {
        callback(null, existingAck);
        return;
      }
      const expectedKey = execution?.inputRound === 2 ? "comment" : "approval";
      const accepted =
        execution?.waitingForInput === true &&
        (call.request.inputs ?? []).length > 0 &&
        (call.request.inputs ?? []).every((input) => input.inputRequestKey === expectedKey);
      if (accepted) {
        options.onControlSideEffect?.(taskId, "update");
        if (execution.scenario === "multi_round_input" && execution.inputRound !== 2) {
          execution.inputRound = 2;
          execution.snapshot = {
            ...execution.snapshot,
            state: "WAITING_INPUT",
            revision: "2",
            reasonCode: "COMMENT_REQUIRED",
            message: "A second input round is required.",
            inputRequests: [
              {
                key: "comment",
                description: "Provide an audit comment.",
                inputSchema: jsonToProtoStruct({ type: "string", minLength: 1 }),
                required: true,
              },
            ],
          };
        } else {
          execution.waitingForInput = false;
          execution.snapshot = {
            ...execution.snapshot,
            state: "RUNNING",
            revision: execution.inputRound === 2 ? "3" : "2",
            reasonCode: "INPUT_ACCEPTED",
            message: "Input accepted; execution resumed.",
            inputRequests: [],
          };
          execution.terminalSnapshot = {
            ...execution.terminalSnapshot,
            revision: execution.inputRound === 2 ? "4" : "3",
          };
        }
      }
      const ack = {
        accepted,
        reasonCode: accepted ? "INPUT_ACCEPTED" : "INPUT_REJECTED",
        message: accepted ? "Input accepted." : "Input was not expected.",
        commandSequence: call.request.identity?.commandSequence ?? "0",
      };
      if (execution !== undefined) {
        execution.commandAcks[commandKey] = ack;
        executions.set(taskId, execution);
      }
      callback(null, ack);
    },
    pauseExecution: createPauseResumeHandler(executions, options, "PAUSED", "pause"),
    resumeExecution: createPauseResumeHandler(executions, options, "RESUMING", "resume"),
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
          commandAcks: {},
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
        if (result.scenario === "input_required" || result.scenario === "multi_round_input") {
          initialSnapshot.state = "WAITING_INPUT";
          initialSnapshot.reasonCode = "APPROVAL_REQUIRED";
          initialSnapshot.message = "Approval input is required.";
          Object.assign(initialSnapshot, {
            inputRequests: [
              {
                key: "approval",
                description: "Approve the reference operation.",
                inputSchema: jsonToProtoStruct({ type: "boolean" }),
                required: true,
              },
            ],
          });
        }
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
          commandAcks: {},
          waitingForInput:
            result.scenario === "input_required" || result.scenario === "multi_round_input",
          ...(result.scenario === "multi_round_input" ? { inputRound: 1 } : {}),
          ...(typeof result.scenario === "string" ? { scenario: result.scenario } : {}),
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
        commandAcks: {},
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

function createPauseResumeHandler(
  executions: JsonFileStore<MockExecution>,
  options: MockAdapterOptions,
  state: "PAUSED" | "RESUMING",
  command: "pause" | "resume",
) {
  return (
    call: grpc.ServerUnaryCall<
      { identity?: { taskId?: string; commandSequence?: string | number } },
      unknown
    >,
    callback: grpc.sendUnaryData<unknown>,
  ) => {
    const taskId = call.request.identity?.taskId ?? "";
    const execution = executions.get(taskId);
    if (execution === undefined) {
      callback(null, {
        accepted: false,
        reasonCode: "EXECUTION_NOT_FOUND",
        message: "Execution does not exist.",
        commandSequence: call.request.identity?.commandSequence ?? "0",
      });
      return;
    }
    const commandKey = `${command}:${String(call.request.identity?.commandSequence ?? "0")}`;
    const existingAck = execution.commandAcks[commandKey];
    if (existingAck !== undefined) {
      callback(null, existingAck);
      return;
    }
    options.onControlSideEffect?.(taskId, command);
    execution.snapshot = {
      ...execution.snapshot,
      state,
      revision: String(Number(execution.snapshot.revision ?? 1) + 1),
      reasonCode: command === "pause" ? "PAUSED_BY_CLIENT" : "RESUMED_BY_CLIENT",
      message: command === "pause" ? "Execution paused." : "Execution resuming.",
    };
    execution.holdSnapshot = command === "pause";
    if (command === "resume") {
      execution.holdReads = 1;
      execution.terminalSnapshot = {
        ...execution.terminalSnapshot,
        revision: String(Number(execution.snapshot.revision ?? 1) + 1),
      };
    }
    const ack = {
      accepted: true,
      reasonCode: command === "pause" ? "PAUSE_ACCEPTED" : "RESUME_ACCEPTED",
      message: `${command} accepted.`,
      commandSequence: call.request.identity?.commandSequence ?? "1",
    };
    execution.commandAcks[commandKey] = ack;
    executions.set(taskId, execution);
    callback(null, ack);
  };
}

export function bindMockAdapter(server: grpc.Server, address: string): Promise<number> {
  return new Promise<number>((resolve, reject) => {
    server.bindAsync(address, grpc.ServerCredentials.createInsecure(), (error, port) => {
      if (error === null) resolve(port);
      else reject(error);
    });
  });
}
