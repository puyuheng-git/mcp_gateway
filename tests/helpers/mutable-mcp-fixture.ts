import { createServer, type ServerResponse } from "node:http";
import { toNodeHandler } from "@modelcontextprotocol/node";
import { createMcpHandler, Server, type Tool } from "@modelcontextprotocol/server";
import { closeHttp, listenHttp } from "../../src/server/http.js";

export async function startMutableFixture(initial: Tool[], pageSize = 37) {
  let tools = initial;
  const subscriptions = new Set<ServerResponse>();
  let subscriptionRequests = 0;
  const handler = createMcpHandler(() => {
    const mcp = new Server(
      { name: "mutable-fixture", version: "1.0.0" },
      { capabilities: { tools: { listChanged: true } } },
    );
    mcp.setRequestHandler("tools/list", async (request) => {
      const offset = Number(request.params?.cursor ?? 0);
      const next = offset + pageSize;
      return {
        tools: tools.slice(offset, next),
        ...(next < tools.length ? { nextCursor: String(next) } : {}),
      };
    });
    return mcp;
  });
  const nodeHandler = toNodeHandler(handler);
  const server = createServer((request, response) => {
    if (request.headers["mcp-method"] === "subscriptions/listen") {
      subscriptionRequests += 1;
      subscriptions.add(response);
      response.once("close", () => subscriptions.delete(response));
    }
    void nodeHandler(request, response).catch(() => {
      response.writeHead(500);
      response.end();
    });
  });
  const url = await listenHttp(server, "127.0.0.1", 0);
  return {
    url,
    get subscriptionCount() {
      return subscriptions.size;
    },
    get subscriptionRequests() {
      return subscriptionRequests;
    },
    disconnectSubscriptions: () => {
      for (const response of subscriptions) response.end();
    },
    updateTools: (next: Tool[]) => {
      tools = next;
      handler.notify.toolsChanged();
    },
    close: async () => {
      await handler.close();
      await closeHttp(server);
    },
  };
}
