import { mkdir, mkdtemp, readFile, rm } from "node:fs/promises";
import { request as httpRequest } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { z } from "zod";
import { defineTool } from "../src/capabilities/types.js";
import { type GatewayConfig, parseConfig } from "../src/config/config.js";
import { createGateway } from "../src/server/gateway.js";
import { connectClient, startFixture, testTokens } from "./helpers/mcp-fixture.js";

const environment = {
  ADMIN: testTokens.admin,
  VIEWER: testTokens.viewer,
  UPSTREAM: testTokens.upstream,
};

function fixtureTools(onWrite: () => void = () => undefined) {
  return [
    defineTool({
      name: "echo",
      description: "Echo",
      inputSchema: z.object({ text: z.string() }).strict(),
      capabilityLevel: "L0",
      requiredScopes: ["git:read"],
      execute: async ({ text }) => ({ text }),
    }),
    defineTool({
      name: "write",
      description: "Write",
      inputSchema: z.object({}).strict(),
      capabilityLevel: "L1",
      requiredScopes: ["git:write"],
      execute: async () => {
        onWrite();
        return { written: true };
      },
    }),
    defineTool({
      name: "production",
      description: "Production",
      inputSchema: z.object({}).strict(),
      capabilityLevel: "L3",
      requiredScopes: ["deploy:production"],
      execute: async () => ({ deployed: true }),
    }),
  ];
}

describe("real MCP gateway integration", () => {
  let directory: string;
  const cleanups: (() => Promise<unknown>)[] = [];

  beforeEach(async () => {
    directory = await mkdtemp(join(tmpdir(), "mcp-gateway-test-"));
  });
  afterEach(async () => {
    for (const cleanup of cleanups.splice(0).reverse()) await cleanup();
    await rm(directory, { recursive: true, force: true });
  });

  async function setup(
    options: {
      timeoutMs?: number;
      slow?: boolean;
      offline?: boolean;
      gateway?: Partial<GatewayConfig["gateway"]>;
    } = {},
  ) {
    let writes = 0;
    const tools = fixtureTools(() => {
      writes += 1;
    });
    if (options.slow) {
      tools.push(
        defineTool({
          name: "slow",
          description: "Slow mutation",
          inputSchema: z.object({}).strict(),
          capabilityLevel: "L1",
          requiredScopes: ["git:write"],
          execute: async (_args, signal) => {
            writes += 1;
            await delay(2000, undefined, { signal });
            return { written: true };
          },
        }),
      );
    }
    const upstream = await startFixture(tools);
    cleanups.push(upstream.close);
    const config = parseConfig(
      {
        gateway: { port: 0, healthIntervalMs: 60_000, sessionTtlMs: 1000, ...options.gateway },
        auth: {
          identities: [
            { id: "admin", tokenEnv: "ADMIN", roles: ["admin"] },
            { id: "viewer", tokenEnv: "VIEWER", roles: ["viewer"] },
          ],
        },
        audit: { path: join(directory, "audit.jsonl") },
        servers: [
          {
            id: "demo",
            name: "Demo",
            transport: "streamable-http",
            url: upstream.url,
            authTokenEnv: "UPSTREAM",
            timeoutMs: options.timeoutMs ?? 1000,
            tools: {
              echo: { capabilityLevel: "L0", requiredScopes: ["git:read"] },
              write: { capabilityLevel: "L1", requiredScopes: ["git:write"] },
              production: { capabilityLevel: "L3", requiredScopes: ["deploy:production"] },
              slow: { capabilityLevel: "L1", requiredScopes: ["git:write"] },
            },
          },
          ...(options.offline
            ? [
                {
                  id: "offline",
                  name: "Offline",
                  transport: "streamable-http",
                  url: "http://127.0.0.1:1/mcp",
                  required: false,
                  timeoutMs: 100,
                },
              ]
            : []),
        ],
      },
      environment,
    );
    const gateway = await createGateway(config, environment);
    cleanups.push(() => gateway.close());
    const url = await gateway.listen();
    return { gateway, url, upstream, writes: () => writes };
  }

  async function client(url: string, role: "admin" | "viewer", legacy = false) {
    const connected = await connectClient(url, testTokens[role], legacy);
    cleanups.push(() => connected.close());
    return connected;
  }

  async function initializeLegacy(url: string, role: "admin" | "viewer") {
    const response = await fetch(url, {
      method: "POST",
      headers: {
        Authorization: `Bearer ${testTokens[role]}`,
        "Content-Type": "application/json",
        Accept: "application/json, text/event-stream",
      },
      body: JSON.stringify({
        jsonrpc: "2.0",
        id: 1,
        method: "initialize",
        params: {
          protocolVersion: "2025-11-25",
          capabilities: {},
          clientInfo: { name: "session-test", version: "1.0.0" },
        },
      }),
    });
    await response.json();
    return response;
  }

  it("aggregates tools with scope filtering and proxies modern structured results", async () => {
    const { url } = await setup();
    const viewer = await client(url, "viewer");
    const admin = await client(url, "admin");
    expect((await viewer.listTools()).tools.map((tool) => tool.name)).toEqual(["demo.echo"]);
    expect((await admin.listTools()).tools.map((tool) => tool.name)).toEqual([
      "demo.echo",
      "demo.write",
    ]);
    const result = await viewer.callTool({
      name: "demo.echo",
      arguments: { text: "through-gateway" },
    });
    expect(result.isError).not.toBe(true);
    expect(result.structuredContent).toEqual({ result: { text: "through-gateway" } });
  });

  it("blocks unauthorized and malformed calls before upstream side effects", async () => {
    const { url, writes } = await setup();
    const viewer = await client(url, "viewer");
    const denied = await viewer.callTool({ name: "demo.write", arguments: {} });
    expect(denied.isError).toBe(true);
    expect(denied._meta?.["gateway/error"]).toMatchObject({
      code: "AUTHORIZATION_DENIED",
      retryable: false,
    });
    const invalid = await viewer.callTool({ name: "demo.echo", arguments: { text: 123 } });
    expect(invalid.isError).toBe(true);
    expect(invalid._meta?.["gateway/error"]).toMatchObject({ code: "INVALID_ARGUMENT" });
    expect(writes()).toBe(0);
  });

  it("rejects malformed pagination cursors as invalid params", async () => {
    const { url } = await setup();
    const viewer = await client(url, "viewer");
    await expect(viewer.listTools({ cursor: "not-a-valid-cursor" })).rejects.toMatchObject({
      code: -32602,
    });
  });

  it("requires authentication on POST, GET and DELETE", async () => {
    const { url } = await setup();
    for (const method of ["POST", "GET", "DELETE"]) {
      const response = await fetch(url, {
        method,
        headers: method === "POST" ? { "Content-Type": "application/json" } : {},
        ...(method === "POST" ? { body: "{}" } : {}),
      });
      expect(response.status).toBe(401);
      expect(response.headers.get("www-authenticate")).toContain("Bearer");
      expect((await response.json()).error.data.code).toBe("AUTHENTICATION_FAILED");
    }
  });

  it("rejects untrusted origins and oversized request bodies", async () => {
    const { url } = await setup();
    const origin = await fetch(url, {
      method: "POST",
      headers: {
        Origin: "https://evil.example",
        Authorization: `Bearer ${testTokens.admin}`,
        "Content-Type": "application/json",
      },
      body: "{}",
    });
    expect(origin.status).toBe(403);
    const large = await fetch(url, {
      method: "POST",
      headers: { Authorization: `Bearer ${testTokens.admin}`, "Content-Type": "application/json" },
      body: JSON.stringify({ payload: "x".repeat(1_048_576) }),
    });
    expect(large.status).toBe(413);
  });

  it("supports legacy clients without allowing cross-identity session reuse", async () => {
    const { url } = await setup();
    const legacy = await client(url, "viewer", true);
    expect((await legacy.listTools()).tools.map((tool) => tool.name)).toEqual(["demo.echo"]);
    const response = await fetch(url, {
      method: "POST",
      headers: {
        Authorization: `Bearer ${testTokens.admin}`,
        "Content-Type": "application/json",
        Accept: "application/json, text/event-stream",
      },
      body: JSON.stringify({
        jsonrpc: "2.0",
        id: 1,
        method: "initialize",
        params: {
          protocolVersion: "2025-11-25",
          capabilities: {},
          clientInfo: { name: "legacy-test", version: "1.0.0" },
        },
      }),
    });
    expect(response.status).toBe(200);
    const sessionId = response.headers.get("mcp-session-id");
    expect(sessionId).toBeTruthy();
    await response.json();
    const hijack = await fetch(url, {
      method: "DELETE",
      headers: {
        Authorization: `Bearer ${testTokens.viewer}`,
        "Mcp-Session-Id": sessionId ?? "",
        "MCP-Protocol-Version": "2025-11-25",
      },
    });
    expect(hijack.status).toBe(404);
    const terminate = await fetch(url, {
      method: "DELETE",
      headers: {
        Authorization: `Bearer ${testTokens.admin}`,
        "Mcp-Session-Id": sessionId ?? "",
        "MCP-Protocol-Version": "2025-11-25",
      },
    });
    expect(terminate.status).toBe(200);
    await terminate.text();
  });

  it("writes paired success and denied audit records without tokens or tool arguments", async () => {
    const { url } = await setup();
    const viewer = await client(url, "viewer");
    await viewer.callTool({ name: "demo.echo", arguments: { text: "sensitive-user-input" } });
    await viewer.callTool({ name: "demo.write", arguments: {} });
    const raw = await readFile(join(directory, "audit.jsonl"), "utf8");
    expect(raw).not.toContain(testTokens.viewer);
    expect(raw).not.toContain("sensitive-user-input");
    const events = raw
      .trim()
      .split("\n")
      .map((line) => JSON.parse(line));
    const start = events.find((event) => event.tool === "demo.echo" && event.phase === "start");
    expect(start).toMatchObject({ identity: "viewer", status: "started", serverId: "demo" });
    expect(
      events.find((event) => event.requestId === start.requestId && event.phase === "finish"),
    ).toMatchObject({ status: "success" });
    expect(events.find((event) => event.tool === "demo.write")).toMatchObject({
      status: "denied",
      errorCode: "AUTHORIZATION_DENIED",
    });
  });

  it("preserves the authenticated identity when HTTP parsing fails", async () => {
    const { url } = await setup();
    const response = await fetch(url, {
      method: "POST",
      headers: { Authorization: `Bearer ${testTokens.viewer}`, "Content-Type": "application/json" },
      body: "not-json",
    });
    expect(response.status).toBe(400);
    const payload = await response.json();
    const events = (await readFile(join(directory, "audit.jsonl"), "utf8"))
      .trim()
      .split("\n")
      .map((line) => JSON.parse(line));
    expect(events.find((event) => event.requestId === payload.error.data.requestId)).toMatchObject({
      identity: "viewer",
      roles: ["viewer"],
      errorCode: "INVALID_ARGUMENT",
    });
  });

  it("fails closed before mutation when audit storage becomes unwritable", async () => {
    const { url, writes } = await setup();
    const admin = await client(url, "admin");
    const auditPath = join(directory, "audit.jsonl");
    await rm(auditPath);
    await mkdir(auditPath);
    const result = await admin.callTool({ name: "demo.write", arguments: {} });
    expect(result.isError).toBe(true);
    expect(result._meta?.["gateway/error"]).toMatchObject({
      code: "AUDIT_UNAVAILABLE",
      retryable: false,
    });
    expect(writes()).toBe(0);
  });

  it("enforces legacy session quotas per identity and releases capacity on deletion", async () => {
    const { url } = await setup({
      gateway: { maxSessions: 2, maxSessionsPerIdentity: 1, sessionTtlMs: 10_000 },
    });
    const first = await initializeLegacy(url, "admin");
    expect(first.status).toBe(200);
    expect((await initializeLegacy(url, "admin")).status).toBe(429);
    expect((await initializeLegacy(url, "viewer")).status).toBe(200);
    const deletion = await fetch(url, {
      method: "DELETE",
      headers: {
        Authorization: `Bearer ${testTokens.admin}`,
        "Mcp-Session-Id": first.headers.get("mcp-session-id") ?? "",
        "MCP-Protocol-Version": "2025-11-25",
      },
    });
    expect(deletion.status).toBe(200);
    await deletion.text();
    expect((await initializeLegacy(url, "admin")).status).toBe(200);
  });

  it("expires legacy sessions and reclaims capacity", async () => {
    const { url } = await setup({ gateway: { maxSessions: 1, sessionTtlMs: 100 } });
    const initialized = await initializeLegacy(url, "admin");
    expect(initialized.status).toBe(200);
    await delay(250);
    const expired = await fetch(url, {
      method: "GET",
      headers: {
        Authorization: `Bearer ${testTokens.admin}`,
        "Mcp-Session-Id": initialized.headers.get("mcp-session-id") ?? "",
        "MCP-Protocol-Version": "2025-11-25",
        Accept: "text/event-stream",
      },
    });
    expect(expired.status).toBe(404);
    await expired.json();
    expect((await initializeLegacy(url, "admin")).status).toBe(200);
  });

  it("accepts only configured origins and hosts", async () => {
    const { url } = await setup({ gateway: { allowedOrigins: ["https://client.example"] } });
    const preflight = await fetch(url, {
      method: "OPTIONS",
      headers: { Origin: "https://client.example" },
    });
    expect(preflight.status).toBe(204);
    expect(preflight.headers.get("access-control-allow-origin")).toBe("https://client.example");
    const rejectedStatus = await new Promise<number>((resolve, reject) => {
      const request = httpRequest(
        url,
        { headers: { Host: "untrusted.example", Authorization: `Bearer ${testTokens.admin}` } },
        (response) => {
          response.resume();
          response.on("end", () => resolve(response.statusCode ?? 0));
        },
      );
      request.on("error", reject);
      request.end();
    });
    expect(rejectedStatus).toBe(403);
  });

  it("removes failed upstream routes and rediscovers them after recovery", async () => {
    const { gateway, url, upstream } = await setup();
    const viewer = await client(url, "viewer");
    await upstream.close();
    await gateway.health.check();
    expect(gateway.health.snapshot().ready).toBe(false);
    expect((await viewer.listTools()).tools).toHaveLength(0);
    const unavailable = await fetch(new URL("/health/ready", url));
    expect(unavailable.status).toBe(503);
    await unavailable.json();
    const restored = await startFixture(fixtureTools(), Number(new URL(upstream.url).port));
    cleanups.push(restored.close);
    await gateway.health.check();
    expect(gateway.health.snapshot().ready).toBe(true);
    expect((await viewer.listTools()).tools.map((tool) => tool.name)).toEqual(["demo.echo"]);
    const result = await viewer.callTool({ name: "demo.echo", arguments: { text: "recovered" } });
    expect(result.structuredContent).toEqual({ result: { text: "recovered" } });
  });

  it("times out mutations without retrying them", async () => {
    const { url, writes } = await setup({ slow: true, timeoutMs: 100 });
    const admin = await client(url, "admin");
    const result = await admin.callTool({ name: "demo.slow", arguments: {} });
    expect(result.isError).toBe(true);
    expect(result._meta?.["gateway/error"]).toMatchObject({ code: "TIMEOUT", retryable: false });
    expect(writes()).toBe(1);
  });

  it("isolates optional upstream failures and protects detailed health", async () => {
    const { url } = await setup({ offline: true });
    const ready = await fetch(new URL("/health/ready", url));
    expect(ready.status).toBe(200);
    expect((await ready.json()).status).toBe("degraded");
    expect((await fetch(new URL("/health", url))).status).toBe(401);
    const detail = await fetch(new URL("/health", url), {
      headers: { Authorization: `Bearer ${testTokens.admin}` },
    });
    const health = await detail.json();
    expect(health.servers.find((server: { id: string }) => server.id === "offline").status).toBe(
      "unavailable",
    );
    const viewer = await client(url, "viewer");
    expect((await viewer.listTools()).tools).toHaveLength(1);
  });
});
