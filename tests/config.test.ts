import { describe, expect, it } from "vitest";
import { parseConfig } from "../src/config/config.js";

const env = { ADMIN_TOKEN: "a".repeat(48), UPSTREAM_TOKEN: "u".repeat(48) };

function input() {
  return {
    auth: { identities: [{ id: "admin", tokenEnv: "ADMIN_TOKEN", roles: ["admin"] }] },
    servers: [
      {
        id: "dev",
        name: "Development",
        transport: "streamable-http",
        url: "http://127.0.0.1:3001/mcp",
      },
    ],
  };
}

describe("trusted configuration", () => {
  it("applies nested defaults, including denying production operations", () => {
    const config = parseConfig(input(), env);
    expect(config.policy.allowProduction).toBe(false);
    expect(config.audit.path).toBe("var/audit/gateway.jsonl");
    expect(config.gateway.port).toBe(3000);
    expect(config.servers[0]?.tools).toEqual({});
  });

  it("rejects missing or short bearer tokens", () => {
    expect(() => parseConfig(input(), {})).toThrow("ADMIN_TOKEN");
    expect(() => parseConfig(input(), { ADMIN_TOKEN: "weak" })).toThrow("32 bytes");
  });

  it("rejects duplicate identities and bearer tokens", () => {
    const duplicate = input();
    duplicate.auth.identities.push({ id: "viewer", tokenEnv: "VIEWER_TOKEN", roles: ["viewer"] });
    expect(() => parseConfig(duplicate, { ...env, VIEWER_TOKEN: env.ADMIN_TOKEN })).toThrow(
      "Duplicate bearer tokens",
    );
    duplicate.auth.identities[1] = { id: "admin", tokenEnv: "VIEWER_TOKEN", roles: ["viewer"] };
    expect(() => parseConfig(duplicate, { ...env, VIEWER_TOKEN: "b".repeat(48) })).toThrow(
      "Duplicate identity IDs",
    );
  });

  it("rejects duplicate public tool aliases", () => {
    const tool = { publicName: "git.status", capabilityLevel: "L0", requiredScopes: ["git:read"] };
    const configuration = input();
    const server = configuration.servers[0];
    expect(() =>
      parseConfig(
        {
          ...configuration,
          servers: [
            { ...server, tools: { status: tool } },
            { ...server, id: "other", tools: { status: tool } },
          ],
        },
        env,
      ),
    ).toThrow("Duplicate public tool names");
  });

  it("expands scalar ENV values without interpreting them as YAML", () => {
    const configuration = input();
    const server = configuration.servers[0];
    if (!server) throw new Error("Missing test server");
    server.url = `\${UPSTREAM_URL:-http://localhost:3001/mcp}`;
    expect(parseConfig(configuration, env).servers[0]).toMatchObject({
      url: "http://localhost:3001/mcp",
    });
    expect(() =>
      parseConfig(configuration, { ...env, UPSTREAM_URL: "http://user:secret@example.com/mcp" }),
    ).toThrow("without credentials");
  });

  it("rejects unknown configuration keys and missing upstream secrets", () => {
    expect(() => parseConfig({ ...input(), allowEverything: true }, env)).toThrow(
      "Invalid configuration",
    );
    const configuration = input();
    expect(() =>
      parseConfig(
        {
          ...configuration,
          servers: [{ ...configuration.servers[0], authTokenEnv: "MISSING_TOKEN" }],
        },
        env,
      ),
    ).toThrow("MISSING_TOKEN");
  });
});
