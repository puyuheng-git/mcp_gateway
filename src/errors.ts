export type ErrorCode =
  | "AUTHENTICATION_FAILED"
  | "AUTHORIZATION_DENIED"
  | "POLICY_DENIED"
  | "TOOL_NOT_FOUND"
  | "MCP_SERVER_UNAVAILABLE"
  | "TOOL_EXECUTION_FAILED"
  | "TIMEOUT"
  | "RATE_LIMITED"
  | "APPROVAL_REQUIRED"
  | "INVALID_ARGUMENT"
  | "INVALID_SESSION"
  | "AUDIT_UNAVAILABLE";

export class GatewayError extends Error {
  constructor(
    readonly code: ErrorCode,
    message: string,
    readonly status = 500,
    readonly retryable = false,
  ) {
    super(message);
    this.name = "GatewayError";
  }
}

export function normalizeError(error: unknown): GatewayError {
  if (error instanceof GatewayError) return error;
  if (error instanceof Error && ["AbortError", "TimeoutError"].includes(error.name)) {
    return new GatewayError("TIMEOUT", "The operation timed out or was cancelled", 504);
  }
  return new GatewayError("TOOL_EXECUTION_FAILED", "The operation failed", 502);
}

export function errorPayload(error: unknown, requestId: string, tool?: string) {
  const failure = normalizeError(error);
  return {
    code: failure.code,
    message: failure.message,
    requestId,
    ...(tool ? { tool } : {}),
    retryable: failure.retryable,
  };
}

export function toolError(error: unknown, requestId: string, tool: string) {
  const payload = errorPayload(error, requestId, tool);
  return {
    isError: true,
    content: [{ type: "text" as const, text: JSON.stringify(payload) }],
    _meta: { "gateway/error": payload },
  };
}
