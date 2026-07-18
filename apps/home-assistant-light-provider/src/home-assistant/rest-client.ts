import { ProviderError, safeProviderError } from "../errors.js";
import type { HomeAssistantState } from "../types.js";
import { homeAssistantStateSchema } from "./schemas.js";

export interface HomeAssistantRestOptions {
  baseUrl: string;
  token: string;
  timeoutMs: number;
}

export class HomeAssistantRestClient {
  readonly #baseUrl: string;
  constructor(readonly options: HomeAssistantRestOptions) {
    this.#baseUrl = options.baseUrl.replace(/\/$/, "");
  }

  async checkApi(): Promise<void> {
    await this.#request("/api/");
  }
  async getState(entityId: string): Promise<HomeAssistantState> {
    const value = await this.#request(`/api/states/${encodeURIComponent(entityId)}`);
    const parsed = homeAssistantStateSchema.safeParse(value);
    if (!parsed.success) throw new ProviderError("HOME_ASSISTANT_PROTOCOL_ERROR", false);
    return parsed.data;
  }
  async getAllStates(): Promise<HomeAssistantState[]> {
    const value = await this.#request("/api/states");
    const parsed = homeAssistantStateSchema.array().safeParse(value);
    if (!parsed.success) throw new ProviderError("HOME_ASSISTANT_PROTOCOL_ERROR", false);
    return parsed.data;
  }
  async callService(
    domain: "light",
    service: "turn_on" | "turn_off",
    data: Record<string, unknown>,
  ): Promise<void> {
    await this.#request(`/api/services/${domain}/${service}`, {
      method: "POST",
      body: JSON.stringify(data),
    });
  }

  async #request(path: string, init: RequestInit = {}): Promise<unknown> {
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), this.options.timeoutMs);
    try {
      const response = await fetch(`${this.#baseUrl}${path}`, {
        ...init,
        signal: controller.signal,
        headers: {
          authorization: `Bearer ${this.options.token}`,
          "content-type": "application/json",
        },
      });
      if (!response.ok) throw statusError(response.status);
      const text = await response.text();
      if (text.length === 0) return {};
      try {
        return JSON.parse(text) as unknown;
      } catch {
        throw new ProviderError("HOME_ASSISTANT_PROTOCOL_ERROR", false);
      }
    } catch (error) {
      throw safeProviderError(error);
    } finally {
      clearTimeout(timeout);
    }
  }
}

function statusError(status: number): ProviderError {
  if (status === 401) return new ProviderError("HOME_ASSISTANT_UNAUTHORIZED", false);
  if (status === 403) return new ProviderError("HOME_ASSISTANT_FORBIDDEN", false);
  if (status === 404) return new ProviderError("HOME_ASSISTANT_NOT_FOUND", false);
  if (status === 400 || status === 422)
    return new ProviderError("HOME_ASSISTANT_BAD_REQUEST", false);
  return new ProviderError("HOME_ASSISTANT_UNAVAILABLE", status === 429 || status >= 500);
}
