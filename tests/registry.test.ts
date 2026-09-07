import type { Tool } from "@modelcontextprotocol/server";
import { describe, expect, it } from "vitest";
import { serverConfigSchema } from "../src/config/config.js";
import { ToolRegistry } from "../src/registry/tool-registry.js";

const upstreamTool: Tool = {
  name: "echo",
  description: "Echo input",
  inputSchema: {
    type: "object",
    properties: { text: { type: "string" } },
    required: ["text"],
    additionalProperties: false,
  },
};
const server = (id = "test", publicName?: string) =>
  serverConfigSchema.parse({
    id,
    name: id,
    transport: "stdio",
    command: "node",
    tools: {
      echo: { publicName, capabilityLevel: "L0", requiredScopes: ["git:read"], idempotent: true },
    },
  });

describe("tool registry", () => {
  it("ignores unconfigured tools and uses local risk and scope metadata", () => {
    const registry = new ToolRegistry();
    registry.replace(server(), [upstreamTool, { ...upstreamTool, name: "untrusted" }]);
    expect(registry.values().map((tool) => tool.definition.name)).toEqual(["test.echo"]);
    expect(registry.get("test.echo")?.definition._meta?.["gateway/policy"]).toMatchObject({
      capabilityLevel: "L0",
      requiredScopes: ["git:read"],
      serverId: "test",
    });
  });

  it("rejects colliding public names without overwriting a route", () => {
    const registry = new ToolRegistry();
    registry.replace(server("first", "git.status"), [upstreamTool]);
    expect(() => registry.replace(server("second", "git.status"), [upstreamTool])).toThrow(
      "Duplicate public tool name",
    );
    expect(registry.get("git.status")?.serverId).toBe("first");
  });

  it("validates input schemas without coercion or silent property removal", () => {
    const registry = new ToolRegistry();
    registry.replace(server(), [upstreamTool]);
    const tool = registry.get("test.echo");
    expect(tool?.validate({ text: "hello" })).toBe(true);
    expect(tool?.validate({ text: 42 })).toBe(false);
    expect(tool?.validate({ text: "hello", unexpected: true })).toBe(false);
  });

  it("replaces tools atomically and removes disconnected server routes", () => {
    const registry = new ToolRegistry();
    registry.replace(server(), [upstreamTool]);
    const originalRevision = registry.revision;
    expect(() => registry.replace(server(), [upstreamTool, upstreamTool])).toThrow(
      "Duplicate upstream tool",
    );
    expect(registry.values()).toHaveLength(1);
    expect(registry.revision).toBe(originalRevision);
    registry.remove("test");
    expect(registry.values()).toHaveLength(0);
    expect(registry.revision).toBeGreaterThan(originalRevision);
  });

  it("does not invalidate pagination when a health refresh finds unchanged tools", () => {
    const registry = new ToolRegistry();
    registry.replace(server(), [upstreamTool]);
    const originalRevision = registry.revision;
    registry.replace(server(), [structuredClone(upstreamTool)]);
    expect(registry.revision).toBe(originalRevision);
  });

  it("notifies clients when public definitions or local routing policy change", () => {
    const registry = new ToolRegistry();
    let notifications = 0;
    registry.subscribe(() => {
      notifications += 1;
    });
    registry.replace(server(), [upstreamTool]);
    registry.replace(server(), [{ ...upstreamTool, description: "Updated description" }]);
    const configuration = server();
    configuration.timeoutMs = 20_000;
    registry.replace(configuration, [{ ...upstreamTool, description: "Updated description" }]);
    expect(notifications).toBe(3);
    expect(registry.revision).toBe(3);
    expect(registry.get("test.echo")?.timeoutMs).toBe(20_000);
    registry.replace(configuration, []);
    expect(registry.revision).toBe(4);
  });

  it("rejects invalid JSON Schema rather than forwarding unchecked input", () => {
    const registry = new ToolRegistry();
    expect(() =>
      registry.replace(server(), [
        {
          ...upstreamTool,
          inputSchema: { type: "object", required: 42 } as unknown as Tool["inputSchema"],
        },
      ]),
    ).toThrow("Invalid input schema");
    expect(registry.values()).toHaveLength(0);
  });
});
