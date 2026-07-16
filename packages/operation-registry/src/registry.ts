import { createHash } from "node:crypto";
import { Ajv2020 } from "ajv/dist/2020.js";
import { protoStructToJson } from "../../adapter-protocol/src/index.js";
import type { OperationDefinition, ProviderManifest } from "../../adapter-protocol/src/index.js";

const OPERATION_NAME = /^[a-z][a-z0-9_]{0,63}$/;
const PROVIDER_ID = /^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/;

export interface ValidatedOperation extends Omit<
  OperationDefinition,
  "inputSchema" | "outputSchema"
> {
  inputSchema: Record<string, unknown>;
  outputSchema: Record<string, unknown>;
  manifestHash: string;
  definition: Record<string, unknown>;
  validateArguments(value: unknown): void;
  tool: {
    name: string;
    description: string;
    inputSchema: Record<string, unknown>;
    outputSchema: Record<string, unknown>;
    _meta: Record<string, unknown>;
  };
}

export interface ValidatedManifest {
  providerId: string;
  providerVersion: string;
  providerType: string;
  manifestHash: string;
  operations: ValidatedOperation[];
}

function canonicalize(value: unknown): string {
  if (value === null || typeof value !== "object") return JSON.stringify(value);
  if (Array.isArray(value)) return `[${value.map(canonicalize).join(",")}]`;
  const object = value as Record<string, unknown>;
  return `{${Object.keys(object)
    .sort()
    .map((key) => `${JSON.stringify(key)}:${canonicalize(object[key])}`)
    .join(",")}}`;
}

function assertComplexity(value: unknown, depth = 0): void {
  if (depth > 32) throw new Error("MANIFEST_SCHEMA_TOO_DEEP");
  if (Array.isArray(value)) {
    if (value.length > 1_024) throw new Error("MANIFEST_SCHEMA_TOO_COMPLEX");
    for (const item of value) assertComplexity(item, depth + 1);
  } else if (typeof value === "object" && value !== null) {
    const entries = Object.entries(value);
    if (entries.length > 1_024) throw new Error("MANIFEST_SCHEMA_TOO_COMPLEX");
    for (const [key, item] of entries) {
      if (key === "pattern" && typeof item === "string" && item.length > 512) {
        throw new Error("MANIFEST_REGEX_TOO_LARGE");
      }
      assertComplexity(item, depth + 1);
    }
  }
}

export class OperationRegistry {
  readonly #ajv: Ajv2020;

  constructor() {
    this.#ajv = new Ajv2020({ strict: true, allErrors: true, validateFormats: true });
    this.#ajv.addFormat("date-time", (value: string) => !Number.isNaN(Date.parse(value)));
  }

  validate(manifest: ProviderManifest): ValidatedManifest {
    if (manifest.adapterProtocolVersion !== "1.0") throw new Error("UNSUPPORTED_ADAPTER_PROTOCOL");
    if (!PROVIDER_ID.test(manifest.providerId)) throw new Error("INVALID_PROVIDER_ID");
    if (manifest.operations.length === 0 || manifest.operations.length > 128) {
      throw new Error("INVALID_OPERATION_COUNT");
    }

    const names = new Set<string>();
    const normalized = manifest.operations.map((operation) => {
      if (!OPERATION_NAME.test(operation.name)) throw new Error("INVALID_OPERATION_NAME");
      if (names.has(operation.name)) throw new Error("DUPLICATE_OPERATION_NAME");
      names.add(operation.name);
      if (operation.execution === "SYNCHRONOUS" && operation.capabilities.scheduling) {
        throw new Error("SYNCHRONOUS_SCHEDULING_CONFLICT");
      }
      const inputSchema = protoStructToJson(operation.inputSchema);
      const outputSchema = protoStructToJson(operation.outputSchema);
      for (const schema of [inputSchema, outputSchema]) {
        const bytes = Buffer.byteLength(JSON.stringify(schema));
        if (bytes > 262_144) throw new Error("MANIFEST_SCHEMA_TOO_LARGE");
        assertComplexity(schema);
      }
      const validateInput = this.#ajv.compile(inputSchema);
      this.#ajv.compile(outputSchema);
      return { ...operation, inputSchema, outputSchema, validateInput };
    });

    const manifestDefinition = {
      adapterProtocolVersion: manifest.adapterProtocolVersion,
      providerId: manifest.providerId,
      providerType: manifest.providerType,
      providerVersion: manifest.providerVersion,
      inventoryMode: manifest.inventoryMode,
      operations: normalized.map(({ validateInput, ...operation }) => {
        void validateInput;
        return operation;
      }),
    };
    const manifestHash = createHash("sha256")
      .update(canonicalize(manifestDefinition))
      .digest("hex");
    const operations = normalized.map(({ validateInput, ...operation }): ValidatedOperation => {
      const definition = { ...operation } as unknown as Record<string, unknown>;
      return {
        ...operation,
        manifestHash,
        definition,
        validateArguments(value: unknown): void {
          if (!validateInput(value)) throw new Error("INVALID_TOOL_ARGUMENTS");
        },
        tool: {
          name: operation.name,
          description: operation.description,
          inputSchema: operation.inputSchema,
          outputSchema: operation.outputSchema,
          _meta: {
            "io.sdar/taskExecution": {
              profileVersion: "1.0",
              execution: operation.execution.toLowerCase(),
              availability: operation.capabilities.availability ? "dynamic" : "not_supported",
              supportsScheduling: operation.capabilities.scheduling,
              supportsMaxElapsed: operation.capabilities.maxElapsed,
              supportsObservations: operation.capabilities.observations,
              supportsInputRequired: operation.capabilities.inputRequired,
              supportsCancel: operation.capabilities.cancel,
              supportsIdempotency: operation.capabilities.idempotency,
            },
          },
        },
      };
    });
    return {
      providerId: manifest.providerId,
      providerType: manifest.providerType,
      providerVersion: manifest.providerVersion,
      manifestHash,
      operations,
    };
  }
}
