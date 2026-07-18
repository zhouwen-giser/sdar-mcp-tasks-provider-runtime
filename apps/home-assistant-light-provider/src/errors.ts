export type HomeAssistantReasonCode =
  | "HOME_ASSISTANT_UNAUTHORIZED"
  | "HOME_ASSISTANT_FORBIDDEN"
  | "HOME_ASSISTANT_NOT_FOUND"
  | "HOME_ASSISTANT_BAD_REQUEST"
  | "HOME_ASSISTANT_UNAVAILABLE"
  | "HOME_ASSISTANT_TIMEOUT"
  | "HOME_ASSISTANT_PROTOCOL_ERROR"
  | "HOME_ASSISTANT_STATE_CONFIRMATION_TIMEOUT"
  | "RESOURCE_NOT_CONFIGURED"
  | "RESOURCE_DISABLED"
  | "BRIGHTNESS_NOT_SUPPORTED"
  | "TASK_IDENTITY_CONFLICT";

export class ProviderError extends Error {
  override readonly name = "ProviderError";

  constructor(
    readonly reasonCode: HomeAssistantReasonCode,
    readonly retryable: boolean,
  ) {
    super(reasonCode);
  }
}

export function safeProviderError(error: unknown): ProviderError {
  if (error instanceof ProviderError) return error;
  if (error instanceof DOMException && error.name === "AbortError") {
    return new ProviderError("HOME_ASSISTANT_TIMEOUT", true);
  }
  return new ProviderError("HOME_ASSISTANT_UNAVAILABLE", true);
}
