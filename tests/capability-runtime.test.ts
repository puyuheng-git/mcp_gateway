import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { expect, it } from "vitest";
import { z } from "zod";
import { defineTool } from "../src/capabilities/types.js";
import { parseConfig } from "../src/config/config.js";
import { createGateway } from "../src/server/gateway.js";
import { connectClient, startFixture, testTokens } from "./helpers/mcp-fixture.js";

it("accepts omitted defaulted inputs through the real gateway and capability runtime", async () => {
  const directory = await mkdtemp(join(tmpdir(), "gateway-defaults-"));
  const upstream = await startFixture([
    defineTool({
      name: "defaults",
      description: "Input defaults",
      capabilityLevel: "L0",
      requiredScopes: ["server:read"],
      inputSchema: z.object({ limit: z.number().int().min(1).default(10) }).strict(),
      execute: async ({ limit }) => ({ limit }),
    }),
  ]);
  const env = { ADMIN: testTokens.admin, UPSTREAM: testTokens.upstream };
  const gateway = await createGateway(
    parseConfig(
      {
        gateway: { port: 0 },
        audit: { path: join(directory, "audit.jsonl") },
        auth: { identities: [{ id: "admin", tokenEnv: "ADMIN", roles: ["admin"] }] },
        servers: [
          {
            id: "test",
            name: "Test",
            transport: "streamable-http",
            url: upstream.url,
            authTokenEnv: "UPSTREAM",
            tools: { defaults: { capabilityLevel: "L0", requiredScopes: ["server:read"] } },
          },
        ],
      },
      env,
    ),
    env,
  );
  try {
    const client = await connectClient(await gateway.listen(), testTokens.admin);
    try {
      const result = await client.callTool({ name: "test.defaults", arguments: {} });
      expect(result.isError).not.toBe(true);
      expect(result.structuredContent).toEqual({ result: { limit: 10 } });
      await gateway.health.check();
      expect(gateway.health.snapshot().ready).toBe(true);
    } finally {
      await client.close();
    }
  } finally {
    await gateway.close();
    await upstream.close();
    await rm(directory, { recursive: true, force: true });
  }
});
