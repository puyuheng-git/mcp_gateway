import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { JsonlAuditLog } from "../src/audit/audit-log.js";
import { Authenticator } from "../src/auth/authentication.js";
import { authorize } from "../src/auth/authorization.js";
import type { Role } from "../src/auth/identity.js";
import { parseConfig, toolPolicySchema } from "../src/config/config.js";
import { PolicyEngine } from "../src/policy/policy-engine.js";

const environment = {
  ADMIN: "admin-".repeat(8),
  VIEWER: "viewer-".repeat(8),
  DEVELOPER: "developer-".repeat(8),
  OPERATOR: "operator-".repeat(8),
};
const roles: Role[] = ["admin", "viewer", "developer", "operator"];
const configuration = parseConfig(
  {
    auth: {
      identities: roles.map((role) => ({ id: role, roles: [role], tokenEnv: role.toUpperCase() })),
    },
    servers: [{ id: "test", name: "Test", transport: "stdio", command: "node" }],
  },
  environment,
);
const authenticator = new Authenticator(configuration.auth, environment);
const actor = (role: Role) =>
  authenticator.authenticate(
    `Bearer ${environment[role.toUpperCase() as keyof typeof environment]}`,
  );

describe("bearer authentication", () => {
  it("rejects absent, malformed and invalid credentials", () => {
    for (const header of [
      undefined,
      "Basic abc",
      "Bearer",
      "Bearer wrong",
      `Bearer ${environment.ADMIN} extra`,
    ]) {
      expect(() => authenticator.authenticate(header)).toThrow("Invalid bearer token");
    }
  });

  it("binds a stable credential identity without returning the bearer secret", () => {
    const identity = actor("admin");
    expect(identity.id).toBe("admin");
    expect(identity.maxCapabilityLevel).toBe(3);
    expect(identity.credentialId).toMatch(/^[a-f0-9]{64}$/);
    expect(JSON.stringify(identity)).not.toContain(environment.ADMIN);
    expect(actor("viewer").credentialId).not.toBe(identity.credentialId);
  });
});

describe("RBAC and minimum v1 policy", () => {
  it("requires every scope and the role risk ceiling", () => {
    const read = toolPolicySchema.parse({ capabilityLevel: "L0", requiredScopes: ["docker:read"] });
    const write = toolPolicySchema.parse({
      capabilityLevel: "L2",
      requiredScopes: ["docker:write"],
    });
    expect(() => authorize(actor("viewer"), read)).not.toThrow();
    expect(() => authorize(actor("viewer"), write)).toThrow();
    expect(() => authorize(actor("developer"), write)).toThrow();
    expect(() => authorize(actor("operator"), write)).not.toThrow();
    expect(() =>
      authorize(actor("developer"), { ...read, requiredScopes: ["git:read", "deploy:production"] }),
    ).toThrow();
  });

  it("blocks production tools even for admin unless explicitly enabled", () => {
    const production = toolPolicySchema.parse({
      capabilityLevel: "L3",
      requiredScopes: ["deploy:production"],
    });
    expect(() =>
      new PolicyEngine({ allowProduction: false }).check(actor("admin"), production),
    ).toThrow("Production tools are disabled");
    expect(() =>
      new PolicyEngine({ allowProduction: true }).check(actor("admin"), production),
    ).not.toThrow();
    expect(() =>
      new PolicyEngine({ allowProduction: true }).check(actor("operator"), production),
    ).toThrow();
  });

  it("uses the same decision for discovery and execution", () => {
    const policy = new PolicyEngine({ allowProduction: false });
    const tool = toolPolicySchema.parse({ capabilityLevel: "L1", requiredScopes: ["blog:write"] });
    expect(policy.allows(actor("viewer"), tool)).toBe(false);
    expect(policy.allows(actor("developer"), tool)).toBe(true);
    expect(policy.allows(actor("admin"), { ...tool, enabled: false })).toBe(false);
  });
});

describe("JSONL audit", () => {
  it("serializes concurrent events into complete JSON lines", async () => {
    const directory = await mkdtemp(join(tmpdir(), "gateway-audit-"));
    try {
      const path = join(directory, "nested", "audit.jsonl");
      const audit = new JsonlAuditLog(path);
      await audit.initialize();
      await Promise.all(
        Array.from({ length: 20 }, (_, index) =>
          audit.write({
            phase: "finish",
            status: "success",
            requestId: `req-${index}`,
            identity: "viewer",
            tool: "git.status",
          }),
        ),
      );
      await audit.close();
      const lines = (await readFile(path, "utf8"))
        .trim()
        .split("\n")
        .map((line) => JSON.parse(line));
      expect(lines).toHaveLength(20);
      expect(new Set(lines.map((line) => line.requestId)).size).toBe(20);
      expect(lines[0]).toMatchObject({ identity: "viewer", phase: "finish", status: "success" });
      expect(lines[0].timestamp).toMatch(/^\d{4}-\d{2}-\d{2}T/);
    } finally {
      await rm(directory, { recursive: true, force: true });
    }
  });
});
