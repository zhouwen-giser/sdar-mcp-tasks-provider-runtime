import { randomUUID } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";
import type { LightExecution } from "../types.js";
import type { QueuedTelemetryEvent } from "../telemetry/durable-queue.js";

export interface ProviderStateDocument {
  version: 1;
  executions: Record<string, LightExecution>;
  pendingTelemetryEvents: QueuedTelemetryEvent[];
  nextTelemetrySequence: number;
}

export interface ExecutionStore {
  get(taskId: string): LightExecution | undefined;
  list(): LightExecution[];
  set(execution: LightExecution): void;
  readDocument(): ProviderStateDocument;
  updateDocument(update: (document: ProviderStateDocument) => void): void;
}

export class JsonExecutionStore implements ExecutionStore {
  constructor(readonly path: string) {
    mkdirSync(dirname(path), { recursive: true });
    if (!existsSync(path)) this.#write(emptyDocument());
    this.#read();
  }
  get(taskId: string): LightExecution | undefined {
    return this.#read().executions[taskId];
  }
  list(): LightExecution[] {
    return Object.values(this.#read().executions);
  }
  set(execution: LightExecution): void {
    this.updateDocument((document) => {
      document.executions[execution.taskId] = execution;
    });
  }
  readDocument(): ProviderStateDocument {
    return structuredClone(this.#read());
  }
  updateDocument(update: (document: ProviderStateDocument) => void): void {
    const document = this.#read();
    update(document);
    this.#write(document);
  }
  #read(): ProviderStateDocument {
    let value: unknown;
    try {
      value = JSON.parse(readFileSync(this.path, "utf8"));
    } catch {
      throw new Error("INVALID_PROVIDER_STATE_FILE");
    }
    if (!validDocument(value)) throw new Error("INVALID_PROVIDER_STATE_FILE");
    return value;
  }
  #write(document: ProviderStateDocument): void {
    const temporary = `${this.path}.${String(process.pid)}.${randomUUID()}.tmp`;
    writeFileSync(temporary, `${JSON.stringify(document)}\n`, { encoding: "utf8", mode: 0o600 });
    renameSync(temporary, this.path);
  }
}

export class MemoryExecutionStore implements ExecutionStore {
  #document = emptyDocument();
  get(taskId: string): LightExecution | undefined {
    return structuredClone(this.#document.executions[taskId]);
  }
  list(): LightExecution[] {
    return structuredClone(Object.values(this.#document.executions));
  }
  set(execution: LightExecution): void {
    this.#document.executions[execution.taskId] = structuredClone(execution);
  }
  readDocument(): ProviderStateDocument {
    return structuredClone(this.#document);
  }
  updateDocument(update: (document: ProviderStateDocument) => void): void {
    update(this.#document);
  }
}

function emptyDocument(): ProviderStateDocument {
  return { version: 1, executions: {}, pendingTelemetryEvents: [], nextTelemetrySequence: 1 };
}
function validDocument(value: unknown): value is ProviderStateDocument {
  return (
    typeof value === "object" &&
    value !== null &&
    "version" in value &&
    value.version === 1 &&
    "executions" in value &&
    typeof value.executions === "object" &&
    value.executions !== null &&
    "pendingTelemetryEvents" in value &&
    Array.isArray(value.pendingTelemetryEvents) &&
    "nextTelemetrySequence" in value &&
    typeof value.nextTelemetrySequence === "number"
  );
}
