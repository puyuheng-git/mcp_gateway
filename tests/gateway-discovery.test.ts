import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import { Client, StreamableHTTPClientTransport, type Tool } from "@modelcontextprotocol/client";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { parseConfig } from "../src/config/config.js";
import { createGateway } from "../src/server/gateway.js";
import { connectClient, testTokens } from "./helpers/mcp-fixture.js";
import { startMutableFixture } from "./helpers/mutable-mcp-fixture.js";

function definitions(count: number): Tool[] {
  return Array.from({ length: count }, (_, index) => ({
    name: `tool-${String(index).padStart(3, "0")}`,
    description: "Discovery fixture",
    inputSchema: { type: "object", properties: {}, additionalProperties: false },
  }));
}

describe("dynamic MCP discovery", () => {
  let directory: string;
  const cleanups: (() => Promise<unknown>)[] = [];
  beforeEach(async () => {
    directory = await mkdtemp(join(tmpdir(), "gateway-discovery-"));
  });
  afterEach(async () => {
    for (const cleanup of cleanups.splice(0).reverse()) await cleanup();
    await rm(directory, { recursive: true, force: true });
  });

  async function setup(count: number, timeoutMs = 1000) {
    const upstream = await startMutableFixture(definitions(count));
    cleanups.push(upstream.close);
    const environment = { VIEWER: testTokens.viewer };
    const gateway = await createGateway(
      parseConfig(
        {
          gateway: { port: 0, healthIntervalMs: 60_000 },
          audit: { path: join(directory, "audit.jsonl") },
          auth: { identities: [{ id: "viewer", tokenEnv: "VIEWER", roles: ["viewer"] }] },
          servers: [
            {
              id: "dynamic",
              name: "Dynamic",
              transport: "streamable-http",
              url: upstream.url,
              timeoutMs,
              defaultPolicy: { capabilityLevel: "L0", requiredScopes: ["server:read"] },
            },
          ],
        },
        environment,
      ),
      environment,
    );
    cleanups.push(gateway.close);
    const url = await gateway.listen();
    return { gateway, upstream, url };
  }

  it("aggregates upstream pages and keeps downstream cursors stable across unchanged health checks", async () => {
    const { gateway, url } = await setup(205);
    const client = await connectClient(url, testTokens.viewer);
    cleanups.push(() => client.close());
    expect((await client.listTools()).tools).toHaveLength(205);
    const first = await client.listTools({ cursor: "" });
    expect(first.tools).toHaveLength(100);
    expect(first.nextCursor).toBeTruthy();
    await gateway.health.check();
    const second = await client.listTools({ cursor: first.nextCursor });
    const third = await client.listTools({ cursor: second.nextCursor });
    expect(second.tools).toHaveLength(100);
    expect(third.tools).toHaveLength(5);
    expect(third.nextCursor).toBeUndefined();
    expect(
      new Set([...first.tools, ...second.tools, ...third.tools].map((tool) => tool.name)).size,
    ).toBe(205);
  });

  it("subscribes to modern upstream changes and notifies downstream clients without waiting for a health tick", async () => {
    const { gateway, upstream, url } = await setup(1);
    let notifications = 0;
    const client = new Client(
      { name: "subscription-test", version: "1.0.0" },
      {
        versionNegotiation: { mode: { pin: "2026-07-28" } },
        listChanged: {
          tools: {
            autoRefresh: false,
            debounceMs: 0,
            onChanged: () => {
              notifications += 1;
            },
          },
        },
      },
    );
    cleanups.push(() => client.close());
    await client.connect(
      new StreamableHTTPClientTransport(new URL(url), {
        requestInit: { headers: { Authorization: `Bearer ${testTokens.viewer}` } },
      }),
    );
    upstream.updateTools(definitions(2));
    await expect.poll(() => gateway.registry.values().length, { timeout: 2000 }).toBe(2);
    await expect.poll(() => notifications, { timeout: 2000 }).toBeGreaterThan(0);
    expect((await client.listTools()).tools).toHaveLength(2);
  });

  it("restores a dropped subscription on a health tick without reconnecting or expiring the replacement", async () => {
    const timeoutMs = 300;
    const { gateway, upstream } = await setup(1, timeoutMs);
    const connected = gateway.upstreams.client("dynamic");
    const subscription = connected.autoOpenedSubscription;
    expect(subscription).toBeDefined();
    expect(upstream.subscriptionCount).toBe(1);
    upstream.disconnectSubscriptions();
    await expect(subscription?.closed).resolves.toBe("remote");
    expect(gateway.upstreams.client("dynamic")).toBe(connected);
    await gateway.health.check();
    expect(gateway.upstreams.client("dynamic")).toBe(connected);
    await expect.poll(() => upstream.subscriptionCount, { timeout: 2000 }).toBe(1);
    expect(upstream.subscriptionRequests).toBe(2);
    await delay(timeoutMs + 100);
    upstream.updateTools(definitions(2));
    await expect.poll(() => gateway.registry.values().length, { timeout: 2000 }).toBe(2);
    await gateway.health.check();
    expect(upstream.subscriptionRequests).toBe(2);
  });

  it("does not restore dropped subscriptions after shutdown", async () => {
    const { gateway, upstream } = await setup(1);
    const subscription = gateway.upstreams.client("dynamic").autoOpenedSubscription;
    expect(subscription).toBeDefined();
    upstream.disconnectSubscriptions();
    await expect(subscription?.closed).resolves.toBe("remote");
    await gateway.close();
    await gateway.upstreams.check();
    expect(upstream.subscriptionCount).toBe(0);
    expect(upstream.subscriptionRequests).toBe(1);
  });
});
