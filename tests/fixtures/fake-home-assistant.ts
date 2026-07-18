import { createServer, type IncomingMessage, type Server, type ServerResponse } from "node:http";
import { WebSocketServer, type WebSocket } from "ws";
import type { HomeAssistantState } from "../../apps/home-assistant-light-provider/src/types.js";

export class FakeHomeAssistant {
  readonly token = "fake-ha-secret-token";
  readonly serviceCalls: { service: string; data: Record<string, unknown> }[] = [];
  readonly #states = new Map<string, HomeAssistantState>();
  readonly #clients = new Set<WebSocket>();
  #server: Server | undefined;
  #websockets: WebSocketServer | undefined;
  url = "";
  applyDelayMs = 0;
  suppressStateChanges = false;
  statusOverride: number | undefined;

  setState(entityId: string, state: string, attributes: Record<string, unknown> = {}): void {
    const now = new Date().toISOString();
    this.#states.set(entityId, {
      entity_id: entityId,
      state,
      attributes,
      last_changed: now,
      last_updated: now,
    });
  }

  async start(): Promise<void> {
    const server = createServer((request, response) => {
      void this.#handle(request, response);
    });
    const websockets = new WebSocketServer({ noServer: true });
    server.on("upgrade", (request, socket, head) => {
      if (request.url !== "/api/websocket") {
        socket.destroy();
        return;
      }
      websockets.handleUpgrade(request, socket, head, (client) =>
        websockets.emit("connection", client, request),
      );
    });
    websockets.on("connection", (client) => {
      this.#clients.add(client);
      client.send(JSON.stringify({ type: "auth_required", ha_version: "2026.7.0" }));
      client.on("message", (raw) => {
        const message = JSON.parse(Buffer.from(raw as Uint8Array).toString("utf8")) as Record<
          string,
          unknown
        >;
        if (message.type === "auth")
          client.send(
            JSON.stringify(
              message.access_token === this.token
                ? { type: "auth_ok", ha_version: "2026.7.0" }
                : { type: "auth_invalid", message: "invalid auth" },
            ),
          );
        if (message.type === "subscribe_events")
          client.send(
            JSON.stringify({ id: message.id, type: "result", success: true, result: null }),
          );
      });
      client.on("close", () => this.#clients.delete(client));
    });
    await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
    const address = server.address();
    if (address === null || typeof address === "string") throw new Error("FAKE_HA_BIND_FAILED");
    this.url = `http://127.0.0.1:${String(address.port)}`;
    this.#server = server;
    this.#websockets = websockets;
  }

  async close(): Promise<void> {
    for (const client of this.#clients) client.terminate();
    this.#websockets?.close();
    if (this.#server !== undefined)
      await new Promise<void>((resolve) => this.#server?.close(() => resolve()));
  }

  disconnectWebSockets(): void {
    for (const client of this.#clients) client.terminate();
  }

  async #handle(request: IncomingMessage, response: ServerResponse): Promise<void> {
    if (request.headers.authorization !== `Bearer ${this.token}`) {
      json(response, 401, { message: "unauthorized" });
      return;
    }
    if (this.statusOverride !== undefined) {
      json(response, this.statusOverride, { message: "injected" });
      return;
    }
    if (request.method === "GET" && request.url === "/api/") {
      json(response, 200, { message: "API running." });
      return;
    }
    if (request.method === "GET" && request.url === "/api/states") {
      json(response, 200, [...this.#states.values()]);
      return;
    }
    if (request.method === "GET" && request.url?.startsWith("/api/states/") === true) {
      const state = this.#states.get(decodeURIComponent(request.url.slice("/api/states/".length)));
      if (state === undefined) json(response, 404, { message: "not found" });
      else json(response, 200, state);
      return;
    }
    const match = /^\/api\/services\/light\/(turn_on|turn_off)$/.exec(request.url ?? "");
    if (request.method === "POST" && match?.[1] !== undefined) {
      const data = await body(request);
      this.serviceCalls.push({ service: match[1], data });
      json(response, 200, []);
      if (!this.suppressStateChanges)
        setTimeout(() => this.#apply(match[1] ?? "", data), this.applyDelayMs);
      return;
    }
    json(response, 404, { message: "not found" });
  }

  #apply(service: string, data: Record<string, unknown>): void {
    const entityId = typeof data.entity_id === "string" ? data.entity_id : "";
    const oldState = this.#states.get(entityId);
    if (oldState === undefined) return;
    const now = new Date().toISOString();
    const attributes = {
      ...oldState.attributes,
      ...(typeof data.brightness === "number" ? { brightness: data.brightness } : {}),
    };
    const newState: HomeAssistantState = {
      ...oldState,
      state: service === "turn_off" ? "off" : "on",
      attributes,
      last_changed: now,
      last_updated: now,
    };
    this.#states.set(entityId, newState);
    const event = {
      id: 1,
      type: "event",
      event: {
        event_type: "state_changed",
        data: { entity_id: entityId, old_state: oldState, new_state: newState },
        origin: "LOCAL",
        time_fired: now,
      },
    };
    for (const client of this.#clients)
      if (client.readyState === client.OPEN) client.send(JSON.stringify(event));
  }
}

function json(response: ServerResponse, status: number, value: unknown): void {
  response.writeHead(status, { "content-type": "application/json" });
  response.end(JSON.stringify(value));
}
async function body(request: IncomingMessage): Promise<Record<string, unknown>> {
  const chunks: Buffer[] = [];
  for await (const chunk of request) chunks.push(Buffer.from(chunk as Uint8Array));
  const value: unknown = JSON.parse(Buffer.concat(chunks).toString("utf8"));
  return typeof value === "object" && value !== null && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : {};
}
