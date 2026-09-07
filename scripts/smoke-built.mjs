import assert from "node:assert/strict";
import { randomBytes } from "node:crypto";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import { Client, StreamableHTTPClientTransport } from "@modelcontextprotocol/client";
import { createBlogTools } from "../dist/capabilities/blog/tools.js";
import { createDevTools } from "../dist/capabilities/dev/tools.js";
import { createInfraTools } from "../dist/capabilities/infra/tools.js";
import { createCapabilityHttpServer } from "../dist/capabilities/runtime.js";
import { loadConfig } from "../dist/config/config.js";
import { createGateway } from "../dist/server/gateway.js";

const directory = await mkdtemp(join(tmpdir(), "mcp-gateway-built-smoke-"));
const token = randomBytes(32).toString("base64url");
const roles = ["viewer", "developer", "operator", "admin"];
const credentials = Object.fromEntries(
  roles.map((role) => [
    `GATEWAY_${role.toUpperCase()}_TOKEN`,
    randomBytes(32).toString("base64url"),
  ]),
);
const capabilities = [];
let gateway;

try {
  capabilities.push(
    createCapabilityHttpServer({
      name: "dev-mcp",
      token,
      tools: createDevTools({ repositories: {} }),
    }),
    createCapabilityHttpServer({ name: "blog-mcp", token, tools: createBlogTools({}) }),
    createCapabilityHttpServer({ name: "infra-mcp", token, tools: createInfraTools() }),
  );
  const [devUrl, blogUrl, infraUrl] = await Promise.all(
    capabilities.map((service) => service.listen()),
  );
  const environment = {
    ...credentials,
    GATEWAY_HOST: "127.0.0.1",
    GATEWAY_PORT: "0",
    GATEWAY_ALLOWED_HOSTS: "127.0.0.1,localhost,[::1]",
    GATEWAY_ALLOWED_ORIGINS: "",
    MCP_UPSTREAM_TOKEN: token,
    DEV_MCP_URL: devUrl,
    BLOG_MCP_URL: blogUrl,
    INFRA_MCP_URL: infraUrl,
  };
  const configuration = loadConfig(
    resolve(import.meta.dirname, "../config/servers.yaml"),
    environment,
  );
  configuration.gateway.healthIntervalMs = 100;
  configuration.audit.path = join(directory, "audit.jsonl");
  gateway = await createGateway(configuration, environment);
  const url = await gateway.listen();
  const checks = [];
  for (const legacy of [false, true]) {
    for (const [role, expected] of [
      ["viewer", 11],
      ["developer", 15],
      ["operator", 17],
      ["admin", 17],
    ]) {
      const client = new Client(
        { name: "built-smoke", version: "1.0.0" },
        { versionNegotiation: { mode: legacy ? "legacy" : { pin: "2026-07-28" } } },
      );
      try {
        await client.connect(
          new StreamableHTTPClientTransport(new URL(url), {
            requestInit: {
              headers: {
                Authorization: `Bearer ${credentials[`GATEWAY_${role.toUpperCase()}_TOKEN`]}`,
              },
            },
          }),
        );
        const { tools } = await client.listTools();
        assert.equal(tools.length, expected);
        const result = await client.callTool({ name: "server.info", arguments: {} });
        assert.notEqual(result.isError, true);
        assert.equal(result.structuredContent.result.platform, process.platform);
        if (role === "viewer") {
          const denial = await client.callTool({
            name: "docker.restart",
            arguments: { container: "not-configured" },
          });
          assert.equal(denial._meta["gateway/error"].code, "AUTHORIZATION_DENIED");
        }
        checks.push({
          protocol: client.getNegotiatedProtocolVersion(),
          role,
          toolCount: tools.length,
          readonlyProbe: "ok",
        });
      } finally {
        await client.close();
      }
    }
  }
  await delay(350);
  assert.equal(gateway.health.snapshot().status, "ok");
  const response = await fetch(new URL("/health/ready", url), {
    signal: AbortSignal.timeout(3000),
  });
  assert.equal(response.status, 200);
  await response.json();
  const audit = await readFile(configuration.audit.path, "utf8");
  const events = audit
    .trim()
    .split("\n")
    .map((line) => JSON.parse(line));
  assert.equal(events.filter((event) => event.status === "success").length, 8);
  assert.equal(events.filter((event) => event.status === "denied").length, 2);
  for (const credential of [token, ...Object.values(credentials)])
    assert.equal(audit.includes(credential), false);
  console.log(
    JSON.stringify(
      { status: "ok", checks, healthAfterRefresh: "ok", auditEvents: events.length },
      null,
      2,
    ),
  );
} finally {
  try {
    await gateway?.close();
  } finally {
    try {
      await Promise.all(capabilities.map((service) => service.close()));
    } finally {
      await rm(directory, { recursive: true, force: true });
    }
  }
}
