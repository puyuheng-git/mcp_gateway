import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { expect, it } from "vitest";
import { parseConfig } from "../src/config/config.js";
import { createGateway } from "../src/server/gateway.js";
import { connectClient, testTokens } from "./helpers/mcp-fixture.js";

it("proxies a real stdio process without forwarding gateway environment secrets", async () => {
  const directory = await mkdtemp(join(tmpdir(), "gateway-stdio-"));
  await writeFile(join(directory, ".env"), "PRIVATE_GATEWAY_TEST_TOKEN=must-not-load-from-disk\n");
  const previousSecret = process.env.PRIVATE_GATEWAY_TEST_TOKEN;
  process.env.PRIVATE_GATEWAY_TEST_TOKEN = "must-not-reach-child";
  const config = parseConfig(
    {
      gateway: { port: 0, healthIntervalMs: 60_000 },
      auth: { identities: [{ id: "admin", tokenEnv: "ADMIN", roles: ["admin"] }] },
      audit: { path: join(directory, "audit.jsonl") },
      servers: [
        {
          id: "local",
          name: "Local",
          transport: "stdio",
          command: process.execPath,
          args: ["--import", "tsx", resolve("tests/fixtures/stdio-server.ts"), "--stdio"],
          timeoutMs: 5000,
          env: { EXPLICIT_STDIO_VALUE: "allowed", CAPABILITY_TEST_CWD: directory },
          tools: {
            inspect_environment: { capabilityLevel: "L0", requiredScopes: ["server:read"] },
          },
        },
      ],
    },
    { ADMIN: testTokens.admin },
  );
  const gateway = await createGateway(config, { ADMIN: testTokens.admin });
  try {
    const url = await gateway.listen();
    const client = await connectClient(url, testTokens.admin);
    try {
      expect((await client.listTools()).tools.map((tool) => tool.name)).toEqual([
        "local.inspect_environment",
      ]);
      await gateway.health.check();
      expect(gateway.health.snapshot().ready).toBe(true);
      expect(
        (await client.callTool({ name: "local.inspect_environment", arguments: {} }))
          .structuredContent,
      ).toEqual({ result: { secretLeaked: false, forwarded: "allowed" } });
    } finally {
      await client.close();
    }
  } finally {
    await gateway.close();
    if (previousSecret === undefined) delete process.env.PRIVATE_GATEWAY_TEST_TOKEN;
    else process.env.PRIVATE_GATEWAY_TEST_TOKEN = previousSecret;
    await rm(directory, { recursive: true, force: true });
  }
});
