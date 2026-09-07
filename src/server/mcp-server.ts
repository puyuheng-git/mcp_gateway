import { randomUUID } from "node:crypto";
import { INVALID_PARAMS, ProtocolError, Server } from "@modelcontextprotocol/server";
import type { Identity } from "../auth/identity.js";
import type { PolicyEngine } from "../policy/policy-engine.js";
import type { ToolRegistry } from "../registry/tool-registry.js";
import type { ToolRouter } from "../router/tool-router.js";
import { requestContext } from "./context.js";

export function createMcpServer(
  identity: Identity,
  registry: ToolRegistry,
  policy: PolicyEngine,
  router: ToolRouter,
): Server {
  const server = new Server(
    { name: "mcp-gateway", version: "1.0.0" },
    {
      capabilities: { tools: { listChanged: true } },
      instructions:
        "Tools are filtered by the authenticated identity. Gateway v1 supports tools only. Mutations are never automatically retried.",
    },
  );
  server.setRequestHandler("tools/list", async (request) => {
    const tools = registry
      .values()
      .filter((tool) => policy.allows(identity, tool.policy))
      .map((tool) => tool.definition);
    let offset = 0;
    if (request.params?.cursor) {
      const cursor = Buffer.from(request.params.cursor, "base64url").toString("utf8");
      const match = /^(\d+):(\d+)$/.exec(cursor);
      if (!match || Number(match[1]) !== registry.revision || Number(match[2]) > tools.length) {
        throw new ProtocolError(INVALID_PARAMS, "Invalid or expired tool-list cursor");
      }
      offset = Number(match[2]);
    }
    const next = offset + 100;
    return {
      tools: tools.slice(offset, next),
      ...(next < tools.length
        ? { nextCursor: Buffer.from(`${registry.revision}:${next}`).toString("base64url") }
        : {}),
    };
  });
  server.setRequestHandler("tools/call", (request, context) =>
    router.call(
      identity,
      request.params.name,
      request.params.arguments ?? {},
      requestContext.getStore()?.requestId ?? randomUUID(),
      context.mcpReq.signal,
    ),
  );
  return server;
}
