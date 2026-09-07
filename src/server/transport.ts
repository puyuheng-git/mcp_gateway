import type { IncomingMessage, ServerResponse } from "node:http";
import { toNodeHandler, toWebRequest } from "@modelcontextprotocol/node";
import { createMcpHandler, isLegacyRequest, type Server } from "@modelcontextprotocol/server";
import type { Identity } from "../auth/identity.js";
import type { GatewayConfig } from "../config/config.js";
import { GatewayError } from "../errors.js";
import { log } from "../runtime/logger.js";
import { SessionManager } from "../session/session-manager.js";
import { requestContext } from "./context.js";

export class McpTransport {
  readonly sessions: SessionManager;
  private readonly modern;
  private readonly modernNodeHandler;

  constructor(
    private readonly factory: (identity: Identity) => Server,
    config: GatewayConfig["gateway"],
  ) {
    this.sessions = new SessionManager(config);
    this.modern = createMcpHandler(
      () => {
        const context = requestContext.getStore();
        if (!context)
          throw new GatewayError("AUTHENTICATION_FAILED", "Missing request identity", 401);
        return factory(context.identity);
      },
      {
        legacy: "reject",
        maxSubscriptions: config.maxSessions,
        onerror: () => log("warn", "mcp_protocol_error"),
      },
    );
    this.modernNodeHandler = toNodeHandler(this.modern, {
      onerror: () => log("error", "mcp_transport_error"),
    });
  }

  async handle(
    request: IncomingMessage,
    response: ServerResponse,
    body: unknown,
    identity: Identity,
  ): Promise<void> {
    const probe = await toWebRequest(request, body);
    if (!(await isLegacyRequest(probe, body))) {
      if (request.headers["mcp-session-id"])
        throw new GatewayError(
          "INVALID_SESSION",
          "Modern MCP requests do not use legacy sessions",
          400,
        );
      await this.modernNodeHandler(request, response, body);
      return;
    }
    const sessionId = request.headers["mcp-session-id"];
    if (typeof sessionId === "string") {
      const session = this.sessions.get(sessionId, identity);
      await session.transport.handleRequest(request, response, body);
      return;
    }
    if (
      request.method !== "POST" ||
      !body ||
      typeof body !== "object" ||
      !("method" in body) ||
      body.method !== "initialize"
    ) {
      throw new GatewayError("INVALID_SESSION", "Initialize an MCP session first", 400);
    }
    const session = await this.sessions.create(identity, this.factory);
    try {
      await session.transport.handleRequest(request, response, body);
    } finally {
      if (!session.transport.sessionId || response.statusCode >= 400)
        await this.sessions.remove(session.id);
    }
  }

  notifyToolsChanged(): void {
    this.modern.notify.toolsChanged();
    void this.sessions.notifyToolsChanged();
  }

  async close(): Promise<void> {
    await Promise.all([this.modern.close(), this.sessions.close()]);
  }
}
