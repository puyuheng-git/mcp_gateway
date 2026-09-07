import { createHash, randomUUID, timingSafeEqual } from "node:crypto";
import type { IncomingMessage, Server, ServerResponse } from "node:http";
import type { AddressInfo } from "node:net";
import { errorPayload, GatewayError, normalizeError } from "../errors.js";

export interface HttpSecurityOptions {
  allowedHosts: readonly string[];
  allowedOrigins: readonly string[];
}

export function secureRequest(
  request: IncomingMessage,
  response: ServerResponse,
  options: HttpSecurityOptions,
): void {
  response.setHeader("X-Content-Type-Options", "nosniff");
  response.setHeader("Cache-Control", "no-store");
  const host = request.headers.host;
  let hostname: string;
  try {
    if (!host || /[\s/@\\?#]/.test(host)) throw new Error("Invalid host");
    hostname = new URL(`http://${host}`).hostname.toLowerCase();
  } catch {
    throw new GatewayError("INVALID_ARGUMENT", "Invalid Host header", 403);
  }
  if (!options.allowedHosts.some((allowed) => allowed.toLowerCase() === hostname)) {
    throw new GatewayError("AUTHORIZATION_DENIED", "Host is not allowed", 403);
  }
  const origin = request.headers.origin;
  if (origin !== undefined) {
    if (!options.allowedOrigins.includes(origin)) {
      throw new GatewayError("AUTHORIZATION_DENIED", "Origin is not allowed", 403);
    }
    response.setHeader("Access-Control-Allow-Origin", origin);
    response.setHeader("Vary", "Origin");
    response.setHeader("Access-Control-Allow-Methods", "POST, GET, DELETE, OPTIONS");
    response.setHeader(
      "Access-Control-Allow-Headers",
      "Authorization, Content-Type, Mcp-Session-Id, MCP-Protocol-Version, Mcp-Method, Mcp-Name, Last-Event-ID",
    );
    response.setHeader(
      "Access-Control-Expose-Headers",
      "Mcp-Session-Id, MCP-Protocol-Version, X-Request-Id",
    );
  }
}

export function requestPath(request: IncomingMessage): string {
  if (!request.url?.startsWith("/") || request.url.startsWith("//")) {
    throw new GatewayError("INVALID_ARGUMENT", "Invalid request target", 400);
  }
  return new URL(request.url, "http://localhost").pathname;
}

export function matchesBearer(header: string | undefined, token: string): boolean {
  const match = /^Bearer ([^\s]+)$/i.exec(header ?? "");
  const actual = createHash("sha256")
    .update(match?.[1] ?? "")
    .digest();
  const expected = createHash("sha256").update(token).digest();
  return timingSafeEqual(actual, expected) && match !== null;
}

export function validateMcpRequest(request: IncomingMessage, response: ServerResponse): void {
  if (!["POST", "GET", "DELETE", "OPTIONS"].includes(request.method ?? "")) {
    response.setHeader("Allow", "POST, GET, DELETE, OPTIONS");
    response.setHeader("Connection", "close");
    throw new GatewayError("INVALID_ARGUMENT", "Method not allowed", 405);
  }
  if (
    request.method !== "POST" &&
    (request.headers["transfer-encoding"] !== undefined ||
      Number(request.headers["content-length"] ?? 0) > 0)
  ) {
    response.setHeader("Connection", "close");
    throw new GatewayError("INVALID_ARGUMENT", "Only POST requests may contain a body", 400);
  }
}

export async function readJson(request: IncomingMessage, limit: number): Promise<unknown> {
  if (request.headers["content-type"]?.split(";")[0]?.trim().toLowerCase() !== "application/json") {
    throw new GatewayError("INVALID_ARGUMENT", "Content-Type must be application/json", 415);
  }
  if (Number(request.headers["content-length"] ?? 0) > limit) {
    request.resume();
    throw new GatewayError("INVALID_ARGUMENT", "Request body exceeds the size limit", 413);
  }
  const chunks: Buffer[] = [];
  let size = 0;
  for await (const chunk of request.iterator({ destroyOnReturn: false })) {
    const buffer = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
    size += buffer.length;
    if (size > limit)
      throw new GatewayError("INVALID_ARGUMENT", "Request body exceeds the size limit", 413);
    chunks.push(buffer);
  }
  try {
    const parsed: unknown = JSON.parse(Buffer.concat(chunks).toString("utf8"));
    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed))
      throw new Error("Invalid request");
    return parsed;
  } catch {
    throw new GatewayError("INVALID_ARGUMENT", "A single JSON-RPC object is required", 400);
  }
}

export function sendJson(response: ServerResponse, status: number, value: unknown): void {
  if (response.headersSent || response.destroyed) return;
  response.writeHead(status, { "Content-Type": "application/json; charset=utf-8" });
  response.end(JSON.stringify(value));
}

export function sendHttpError(
  response: ServerResponse,
  error: unknown,
  requestId = randomUUID(),
): void {
  const failure = normalizeError(error);
  if (response.headersSent) {
    response.end();
    return;
  }
  if (failure.status === 401) response.setHeader("WWW-Authenticate", 'Bearer realm="mcp-gateway"');
  if (failure.status === 413 || !response.req.complete) {
    response.setHeader("Connection", "close");
    response.req.resume();
  }
  sendJson(response, failure.status, {
    jsonrpc: "2.0",
    id: null,
    error: {
      code: failure.code === "INVALID_ARGUMENT" ? -32602 : -32000,
      message: failure.message,
      data: errorPayload(failure, requestId),
    },
  });
}

export async function listenHttp(server: Server, host: string, port: number): Promise<string> {
  server.requestTimeout = 30_000;
  server.headersTimeout = 10_000;
  server.keepAliveTimeout = 5000;
  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen(port, host, () => {
      server.off("error", reject);
      resolve();
    });
  });
  const address = server.address() as AddressInfo;
  const hostname = host === "0.0.0.0" ? "127.0.0.1" : host.includes(":") ? `[${host}]` : host;
  return `http://${hostname}:${address.port}/mcp`;
}

export async function closeHttp(server: Server): Promise<void> {
  if (!server.listening) return;
  const closing = new Promise<void>((resolve) => server.close(() => resolve()));
  server.closeIdleConnections();
  const force = setTimeout(() => server.closeAllConnections(), 1500);
  force.unref();
  await closing;
  clearTimeout(force);
}
