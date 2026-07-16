import { Server } from "@modelcontextprotocol/sdk/server/index.js";
import { StreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/streamableHttp.js";
import type { Transport } from "@modelcontextprotocol/sdk/shared/transport.js";
import { CallToolRequestSchema, ListToolsRequestSchema } from "@modelcontextprotocol/sdk/types.js";
import type { IncomingMessage, ServerResponse } from "node:http";
import { protoStructToJson } from "../../adapter-protocol/src/index.js";
import type { GrpcAdapterGateway } from "../../adapter-protocol/src/index.js";
import type { ValidatedManifest } from "../../operation-registry/src/index.js";

export class McpProtocolHandler {
  constructor(
    readonly manifest: ValidatedManifest,
    readonly gateway: GrpcAdapterGateway,
  ) {}

  async handle(request: IncomingMessage, response: ServerResponse, body: unknown): Promise<void> {
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

    const transport = new StreamableHTTPServerTransport();
    await server.connect(transport as unknown as Transport);
    response.once("close", () => {
      void transport.close();
      void server.close();
    });
    await transport.handleRequest(request, response, body);
  }
}
