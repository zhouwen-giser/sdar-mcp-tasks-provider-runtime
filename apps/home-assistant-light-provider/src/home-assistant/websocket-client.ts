import { EventEmitter } from "node:events";
import WebSocket, { type RawData } from "ws";
import { homeAssistantStateSchema } from "./schemas.js";
import type { HomeAssistantState } from "../types.js";

export interface HomeAssistantWebSocketOptions {
  baseUrl: string;
  token: string;
  entityIds: ReadonlySet<string>;
  reconnectMinMs: number;
  reconnectMaxMs: number;
  authTimeoutMs?: number;
}

export class HomeAssistantWebSocketClient {
  readonly #events = new EventEmitter();
  #socket: WebSocket | undefined;
  #stopped = true;
  #requestId = 1;
  #reconnectDelay: number;
  #reconnectTimer: NodeJS.Timeout | undefined;
  #pingTimer: NodeJS.Timeout | undefined;

  constructor(readonly options: HomeAssistantWebSocketOptions) {
    this.#reconnectDelay = options.reconnectMinMs;
  }

  onState(listener: (state: HomeAssistantState) => void): () => void {
    this.#events.on("state", listener);
    return () => this.#events.off("state", listener);
  }

  onConnectivity(listener: (connected: boolean) => void): () => void {
    this.#events.on("connectivity", listener);
    return () => this.#events.off("connectivity", listener);
  }

  start(): void {
    if (!this.#stopped) return;
    this.#stopped = false;
    this.#connect();
  }

  stop(): void {
    this.#stopped = true;
    if (this.#reconnectTimer !== undefined) clearTimeout(this.#reconnectTimer);
    if (this.#pingTimer !== undefined) clearInterval(this.#pingTimer);
    this.#socket?.close();
    this.#socket = undefined;
  }

  #connect(): void {
    if (this.#stopped) return;
    const websocketUrl = new URL(this.options.baseUrl);
    websocketUrl.protocol = websocketUrl.protocol === "https:" ? "wss:" : "ws:";
    websocketUrl.pathname = `${websocketUrl.pathname.replace(/\/$/, "")}/api/websocket`;
    const socket = new WebSocket(websocketUrl);
    this.#socket = socket;
    const authTimer = setTimeout(() => socket.terminate(), this.options.authTimeoutMs ?? 5000);
    let authenticated = false;

    socket.on("message", (data) => {
      const message = parseMessage(data);
      if (message === undefined) return;
      if (message.type === "auth_required") {
        socket.send(JSON.stringify({ type: "auth", access_token: this.options.token }));
        return;
      }
      if (message.type === "auth_ok") {
        clearTimeout(authTimer);
        authenticated = true;
        this.#reconnectDelay = this.options.reconnectMinMs;
        socket.send(
          JSON.stringify({
            id: this.#requestId++,
            type: "subscribe_events",
            event_type: "state_changed",
          }),
        );
        this.#events.emit("connectivity", true);
        this.#pingTimer = setInterval(() => {
          if (socket.readyState === WebSocket.OPEN) socket.ping();
        }, 20_000);
        return;
      }
      if (message.type === "auth_invalid") {
        socket.close();
        return;
      }
      const state = extractStateChanged(message);
      if (state !== undefined && this.options.entityIds.has(state.entity_id))
        this.#events.emit("state", state);
    });
    socket.on("error", () => undefined);
    socket.on("close", () => {
      clearTimeout(authTimer);
      if (this.#pingTimer !== undefined) clearInterval(this.#pingTimer);
      this.#pingTimer = undefined;
      if (authenticated) this.#events.emit("connectivity", false);
      if (!this.#stopped) {
        this.#reconnectTimer = setTimeout(() => this.#connect(), this.#reconnectDelay);
        this.#reconnectDelay = Math.min(this.options.reconnectMaxMs, this.#reconnectDelay * 2);
      }
    });
  }
}

function parseMessage(data: RawData): Record<string, unknown> | undefined {
  try {
    const value: unknown = JSON.parse(rawDataText(data));
    return isRecord(value) ? value : undefined;
  } catch {
    return undefined;
  }
}

function rawDataText(data: RawData): string {
  if (typeof data === "string") return data;
  if (data instanceof ArrayBuffer) return Buffer.from(data).toString("utf8");
  if (Array.isArray(data)) return Buffer.concat(data).toString("utf8");
  return Buffer.from(data).toString("utf8");
}

function extractStateChanged(message: Record<string, unknown>): HomeAssistantState | undefined {
  if (
    message.type !== "event" ||
    !isRecord(message.event) ||
    message.event.event_type !== "state_changed" ||
    !isRecord(message.event.data)
  )
    return undefined;
  const parsed = homeAssistantStateSchema.safeParse(message.event.data.new_state);
  return parsed.success ? parsed.data : undefined;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
