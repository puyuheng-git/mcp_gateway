import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { parse } from "yaml";
import { z } from "zod";
import { roleNames } from "../auth/identity.js";
import { type Environment, readSecret } from "./secrets.js";

const envName = z.string().regex(/^[A-Z_][A-Z0-9_]*$/);
const toolName = z.string().regex(/^[a-zA-Z0-9_.-]{1,128}$/);
const scopes = z.array(z.string().regex(/^[a-zA-Z0-9_.*-]+(?::[a-zA-Z0-9_.*-]+)*$/));
const timeout = z.number().int().positive().max(300_000);

const basePolicySchema = z
  .object({
    capabilityLevel: z.enum(["L0", "L1", "L2", "L3"]),
    requiredScopes: scopes.min(1),
    enabled: z.boolean().default(true),
    timeoutMs: timeout.optional(),
    idempotent: z.boolean().default(false),
    sideEffects: z.array(z.string().min(1)).default([]),
    version: z.string().min(1).default("1.0.0"),
  })
  .strict();

export const toolPolicySchema = basePolicySchema.extend({ publicName: toolName.optional() });
export type ToolPolicy = z.infer<typeof toolPolicySchema>;

const httpUrl = z.url().refine((value) => {
  const url = new URL(value);
  return ["http:", "https:"].includes(url.protocol) && !url.username && !url.password && !url.hash;
}, "Expected an HTTP(S) URL without credentials or a fragment");

const serverFields = {
  id: z.string().regex(/^[a-z][a-z0-9-]{0,31}$/),
  name: z.string().min(1),
  enabled: z.boolean().default(true),
  required: z.boolean().default(true),
  timeoutMs: timeout.default(10_000),
  tools: z.record(toolName, toolPolicySchema).default({}),
  defaultPolicy: basePolicySchema.optional(),
};

export const serverConfigSchema = z.discriminatedUnion("transport", [
  z
    .object({
      ...serverFields,
      transport: z.literal("streamable-http"),
      url: httpUrl,
      authTokenEnv: envName.optional(),
    })
    .strict(),
  z
    .object({
      ...serverFields,
      transport: z.literal("stdio"),
      command: z.string().min(1),
      args: z.array(z.string()).default([]),
      cwd: z.string().min(1).optional(),
      env: z.record(z.string(), z.string()).default({}),
    })
    .strict(),
]);

const schema = z
  .object({
    gateway: z
      .object({
        host: z.string().min(1).default("127.0.0.1"),
        port: z.number().int().min(0).max(65_535).default(3000),
        allowedHosts: z
          .array(
            z
              .string()
              .min(1)
              .refine((host) => !/[\s/*@]/.test(host)),
          )
          .min(1)
          .default(["localhost", "127.0.0.1", "[::1]"]),
        allowedOrigins: z
          .array(
            httpUrl.refine((url) => new URL(url).origin === url, "Use an origin without a path"),
          )
          .default([]),
        requestBodyLimitBytes: z.number().int().min(1024).max(16_777_216).default(1_048_576),
        sessionTtlMs: z.number().int().positive().default(1_800_000),
        maxSessions: z.number().int().positive().max(100_000).default(1000),
        maxSessionsPerIdentity: z.number().int().positive().default(100),
        healthIntervalMs: z.number().int().min(100).default(30_000),
      })
      .strict()
      .prefault({}),
    auth: z
      .object({
        identities: z
          .array(
            z
              .object({
                id: z.string().regex(/^[a-zA-Z0-9_-]{1,64}$/),
                tokenEnv: envName,
                roles: z.array(z.enum(roleNames)).min(1),
                scopes: scopes.default([]),
              })
              .strict(),
          )
          .min(1),
      })
      .strict(),
    policy: z
      .object({ allowProduction: z.boolean().default(false) })
      .strict()
      .prefault({}),
    audit: z
      .object({ path: z.string().min(1).default("var/audit/gateway.jsonl") })
      .strict()
      .prefault({}),
    servers: z.array(serverConfigSchema).min(1),
  })
  .strict();

export type GatewayConfig = z.infer<typeof schema>;
export type ServerConfig = z.infer<typeof serverConfigSchema>;

function interpolate(value: unknown, env: Environment): unknown {
  if (typeof value === "string") {
    return value.replace(
      /\$\{([A-Z_][A-Z0-9_]*)(?::-([^}]*))?\}/g,
      (_match, name: string, fallback?: string) => {
        const replacement = env[name] || fallback;
        if (replacement === undefined) throw new Error(`Missing environment variable ${name}`);
        return replacement;
      },
    );
  }
  if (Array.isArray(value)) return value.map((entry) => interpolate(entry, env));
  if (value !== null && typeof value === "object") {
    return Object.fromEntries(
      Object.entries(value).map(([key, entry]) => [key, interpolate(entry, env)]),
    );
  }
  return value;
}

function assertUnique(values: string[], description: string): void {
  if (new Set(values).size !== values.length)
    throw new Error(`Duplicate ${description} in configuration`);
}

export function parseConfig(input: unknown, env: Environment = process.env): GatewayConfig {
  const expanded = interpolate(input, env);
  if (expanded && typeof expanded === "object" && !Array.isArray(expanded)) {
    const configuration = expanded as Record<string, unknown>;
    const gateway = { ...(configuration.gateway as Record<string, unknown> | undefined) };
    if (env.GATEWAY_HOST) gateway.host = env.GATEWAY_HOST;
    if (env.GATEWAY_PORT) gateway.port = Number(env.GATEWAY_PORT);
    if (env.GATEWAY_ALLOWED_HOSTS !== undefined)
      gateway.allowedHosts = csv(env.GATEWAY_ALLOWED_HOSTS);
    if (env.GATEWAY_ALLOWED_ORIGINS !== undefined)
      gateway.allowedOrigins = csv(env.GATEWAY_ALLOWED_ORIGINS);
    configuration.gateway = gateway;
  }
  const parsed = schema.safeParse(expanded);
  if (!parsed.success) {
    throw new Error(
      `Invalid configuration: ${parsed.error.issues.map((issue) => `${issue.path.join(".")}: ${issue.message}`).join("; ")}`,
    );
  }
  const config = parsed.data;
  assertUnique(
    config.servers.map((server) => server.id),
    "server IDs",
  );
  assertUnique(
    config.auth.identities.map((identity) => identity.id),
    "identity IDs",
  );
  assertUnique(
    config.auth.identities.map((identity) => identity.tokenEnv),
    "identity token references",
  );
  assertUnique(
    config.servers
      .filter((server) => server.enabled)
      .flatMap((server) =>
        Object.entries(server.tools)
          .filter(([, policy]) => policy.enabled)
          .map(([name, policy]) => policy.publicName ?? `${server.id}.${name}`),
      ),
    "public tool names",
  );
  const tokens = config.auth.identities.map((identity) => readSecret(identity.tokenEnv, env));
  if (tokens.some((token) => Buffer.byteLength(token) < 32)) {
    throw new Error("Gateway bearer tokens must contain at least 32 bytes");
  }
  assertUnique(tokens, "bearer tokens");
  for (const server of config.servers) {
    if (server.enabled && server.transport === "streamable-http" && server.authTokenEnv) {
      readSecret(server.authTokenEnv, env);
    }
  }
  return config;
}

export function loadConfig(
  path = "config/servers.yaml",
  env: Environment = process.env,
): GatewayConfig {
  const content = readFileSync(resolve(path), "utf8");
  if (Buffer.byteLength(content) > 1_048_576)
    throw new Error("Configuration exceeds the 1 MiB limit");
  return parseConfig(parse(content, { maxAliasCount: 100 }), env);
}

export function csv(value: string | undefined): string[] {
  return (value ?? "")
    .split(",")
    .map((entry) => entry.trim())
    .filter(Boolean);
}
