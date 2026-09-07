import { randomUUID } from "node:crypto";
import { createServer } from "node:http";
import { toNodeHandler } from "@modelcontextprotocol/node";
import { createMcpHandler, Server, type Tool } from "@modelcontextprotocol/server";
import { serveStdio } from "@modelcontextprotocol/server/stdio";
import { config as loadEnv } from "dotenv";
import { z } from "zod";
import { csv } from "../config/config.js";
import { readSecret } from "../config/secrets.js";
import { GatewayError, toolError } from "../errors.js";
import { log } from "../runtime/logger.js";
import {
  closeHttp,
  listenHttp,
  matchesBearer,
  readJson,
  requestPath,
  secureRequest,
  sendHttpError,
  sendJson,
  validateMcpRequest,
} from "../server/http.js";
import type { CapabilityTool } from "./types.js";

export function createCapabilityMcpServer(name: string, tools: CapabilityTool[]): Server {
  const server = new Server({ name, version: "1.0.0" }, { capabilities: { tools: {} } });
  const definitions: Tool[] = tools.map((tool) => ({
    name: tool.name,
    description: tool.description,
    inputSchema: z.toJSONSchema(tool.inputSchema, {
      target: "draft-7",
      io: "input",
    }) as Tool["inputSchema"],
    outputSchema: {
      type: "object",
      properties: { result: {} },
      required: ["result"],
      additionalProperties: false,
    },
    annotations: {
      readOnlyHint: tool.capabilityLevel === "L0",
      destructiveHint: Number(tool.capabilityLevel.slice(1)) >= 2,
      idempotentHint: tool.idempotent,
    },
    _meta: {
      "gateway/policy": {
        capabilityLevel: tool.capabilityLevel,
        requiredScopes: tool.requiredScopes,
        idempotent: tool.idempotent,
        sideEffects: tool.sideEffects,
        version: "1.0.0",
      },
    },
  }));
  if (new Set(definitions.map((tool) => tool.name)).size !== tools.length)
    throw new Error("Duplicate capability tool names");
  const byName = new Map(tools.map((tool) => [tool.name, tool]));
  server.setRequestHandler("tools/list", async () => ({ tools: definitions }));
  server.setRequestHandler("tools/call", async (request, context) => {
    const requestId = randomUUID();
    try {
      const tool = byName.get(request.params.name);
      if (!tool) throw new GatewayError("TOOL_NOT_FOUND", "Unknown capability tool", 404);
      const value = await tool.execute(request.params.arguments ?? {}, context.mcpReq.signal);
      const text = JSON.stringify({ result: value ?? null });
      if (Buffer.byteLength(text) > 4_194_304)
        throw new GatewayError("TOOL_EXECUTION_FAILED", "Tool output exceeds the size limit", 502);
      return {
        content: [{ type: "text" as const, text }],
        structuredContent: JSON.parse(text) as Record<string, unknown>,
      };
    } catch (error) {
      const failure =
        error instanceof z.ZodError
          ? new GatewayError(
              "INVALID_ARGUMENT",
              "Tool arguments do not match the input schema",
              400,
            )
          : error;
      return toolError(failure, requestId, request.params.name);
    }
  });
  return server;
}

export interface CapabilityHttpOptions {
  name: string;
  tools: CapabilityTool[];
  token: string;
  host?: string;
  port?: number;
  allowedHosts?: string[];
  allowedOrigins?: string[];
}

export function createCapabilityHttpServer(options: CapabilityHttpOptions) {
  if (Buffer.byteLength(options.token) < 32)
    throw new Error("Capability bearer tokens must contain at least 32 bytes");
  const handler = createMcpHandler(() => createCapabilityMcpServer(options.name, options.tools), {
    onerror: () => log("warn", "capability_protocol_error", { service: options.name }),
  });
  const nodeHandler = toNodeHandler(handler);
  const security = {
    allowedHosts: options.allowedHosts ?? ["localhost", "127.0.0.1", "[::1]"],
    allowedOrigins: options.allowedOrigins ?? [],
  };
  const server = createServer((request, response) => {
    const requestId = randomUUID();
    response.setHeader("X-Request-Id", requestId);
    void (async () => {
      secureRequest(request, response, security);
      const path = requestPath(request);
      if (["/health/live", "/health/ready"].includes(path) && request.method === "GET") {
        sendJson(response, 200, { status: "ok" });
        return;
      }
      if (path !== "/mcp") {
        sendJson(response, 404, { error: "Not found" });
        return;
      }
      if (request.method === "OPTIONS") {
        validateMcpRequest(request, response);
        response.writeHead(204);
        response.end();
        return;
      }
      if (!matchesBearer(request.headers.authorization, options.token)) {
        throw new GatewayError("AUTHENTICATION_FAILED", "Invalid bearer token", 401);
      }
      validateMcpRequest(request, response);
      const body = request.method === "POST" ? await readJson(request, 1_048_576) : undefined;
      await nodeHandler(request, response, body);
    })().catch((error: unknown) => sendHttpError(response, error, requestId));
  });
  let closed = false;
  return {
    listen: () => listenHttp(server, options.host ?? "127.0.0.1", options.port ?? 0),
    close: async () => {
      if (closed) return;
      closed = true;
      await handler.close();
      await closeHttp(server);
    },
  };
}

export function installShutdown(close: () => Promise<void>): void {
  let stopping = false;
  const shutdown = () => {
    if (stopping) return;
    stopping = true;
    const deadline = setTimeout(() => process.exit(1), 15_000);
    deadline.unref();
    void close().then(
      () => {
        clearTimeout(deadline);
        process.exitCode = 0;
      },
      () => {
        log("error", "shutdown_failed");
        process.exitCode = 1;
      },
    );
  };
  process.once("SIGINT", shutdown);
  process.once("SIGTERM", shutdown);
}

export function loadCapabilityEnvironment(): void {
  if (!process.argv.includes("--stdio")) loadEnv({ quiet: true });
}

export async function runCapability(
  name: string,
  defaultPort: number,
  tools: CapabilityTool[],
): Promise<void> {
  if (process.argv.includes("--stdio")) {
    const handle = serveStdio(() => createCapabilityMcpServer(name, tools), {
      onerror: () => log("warn", "capability_stdio_error", { service: name }),
    });
    installShutdown(() => handle.close());
    return;
  }
  const port = z.coerce
    .number()
    .int()
    .min(1)
    .max(65_535)
    .parse(process.env.MCP_PORT ?? defaultPort);
  const service = createCapabilityHttpServer({
    name,
    tools,
    port,
    token: readSecret("MCP_UPSTREAM_TOKEN"),
    host: process.env.MCP_HOST ?? "127.0.0.1",
    allowedHosts: process.env.MCP_ALLOWED_HOSTS ? csv(process.env.MCP_ALLOWED_HOSTS) : undefined,
    allowedOrigins: csv(process.env.MCP_ALLOWED_ORIGINS),
  });
  await service.listen();
  installShutdown(service.close);
  log("info", "capability_listening", { service: name, port });
}
