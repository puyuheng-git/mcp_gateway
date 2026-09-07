import { mkdtemp, readFile, rm } from "node:fs/promises";
import { createServer } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { toNodeHandler } from "@modelcontextprotocol/node";
import { createMcpHandler, ProtocolError, Server } from "@modelcontextprotocol/server";
import { expect, it } from "vitest";
import { parseConfig } from "../src/config/config.js";
import { createGateway } from "../src/server/gateway.js";
import { closeHttp, listenHttp } from "../src/server/http.js";
import { connectClient, testTokens } from "./helpers/mcp-fixture.js";

it("never resends a mutation when the SDK receives HEADER_MISMATCH", async () => {
  const directory = await mkdtemp(join(tmpdir(), "gateway-no-retry-"));
  let calls = 0;
  const handler = createMcpHandler(() => {
    const server = new Server(
      { name: "retry-fixture", version: "1.0.0" },
      { capabilities: { tools: {} } },
    );
    server.setRequestHandler("tools/list", async () => ({
      tools: [
        {
          name: "write",
          inputSchema: { type: "object", properties: {}, additionalProperties: false },
        },
      ],
    }));
    server.setRequestHandler("tools/call", async () => {
      calls += 1;
      if (calls === 1) throw new ProtocolError(-32020, "Tool header definition changed");
      return { content: [{ type: "text", text: "Mutation was repeated" }] };
    });
    return server;
  });
  const nodeHandler = toNodeHandler(handler);
  const upstream = createServer((request, response) => {
    void nodeHandler(request, response);
  });
  const environment = { ADMIN: testTokens.admin };
  const gateway = await createGateway(
    parseConfig(
      {
        gateway: { port: 0 },
        auth: { identities: [{ id: "admin", tokenEnv: "ADMIN", roles: ["admin"] }] },
        audit: { path: join(directory, "audit.jsonl") },
        servers: [
          {
            id: "retry",
            name: "Retry",
            transport: "streamable-http",
            url: await listenHttp(upstream, "127.0.0.1", 0),
            tools: {
              write: {
                publicName: "git.write",
                capabilityLevel: "L1",
                requiredScopes: ["git:write"],
              },
            },
          },
        ],
      },
      environment,
    ),
    environment,
  );
  try {
    const client = await connectClient(await gateway.listen(), testTokens.admin);
    try {
      const result = await client.callTool({ name: "git.write", arguments: {} });
      expect(calls).toBe(1);
      expect(result.isError).toBe(true);
      expect(result._meta?.["gateway/error"]).toMatchObject({
        code: "TOOL_EXECUTION_FAILED",
        retryable: false,
      });
      const audit = (await readFile(join(directory, "audit.jsonl"), "utf8"))
        .trim()
        .split("\n")
        .map((line) => JSON.parse(line));
      expect(audit).toHaveLength(2);
      expect(audit[1]).toMatchObject({ phase: "finish", status: "error" });
    } finally {
      await client.close();
    }
  } finally {
    await gateway.close();
    await handler.close();
    await closeHttp(upstream);
    await rm(directory, { recursive: true, force: true });
  }
});
