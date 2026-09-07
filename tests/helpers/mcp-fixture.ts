import { Client, StreamableHTTPClientTransport } from "@modelcontextprotocol/client";
import { createCapabilityHttpServer } from "../../src/capabilities/runtime.js";
import type { CapabilityTool } from "../../src/capabilities/types.js";

export const testTokens = {
  admin: "admin-test-token-".repeat(4),
  viewer: "viewer-test-token-".repeat(4),
  upstream: "upstream-test-token-".repeat(4),
};

export async function startFixture(tools: CapabilityTool[], port = 0) {
  const service = createCapabilityHttpServer({
    name: "test-upstream",
    tools,
    token: testTokens.upstream,
    host: "127.0.0.1",
    port,
  });
  const url = await service.listen();
  return { ...service, url };
}

export async function connectClient(url: string, token: string, legacy = false) {
  const client = new Client(
    { name: "gateway-test", version: "1.0.0" },
    {
      versionNegotiation: { mode: legacy ? "legacy" : { pin: "2026-07-28" } },
    },
  );
  const transport = new StreamableHTTPClientTransport(new URL(url), {
    requestInit: { headers: { Authorization: `Bearer ${token}` } },
  });
  await client.connect(transport);
  return client;
}
