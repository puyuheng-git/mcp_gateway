import { isDeepStrictEqual } from "node:util";
import type { Tool } from "@modelcontextprotocol/server";
import { Ajv, type ValidateFunction } from "ajv";
import { Ajv2020 } from "ajv/dist/2020.js";
import type { ServerConfig, ToolPolicy } from "../config/config.js";
import { GatewayError } from "../errors.js";

export interface RegisteredTool {
  serverId: string;
  upstreamName: string;
  definition: Tool;
  policy: ToolPolicy;
  timeoutMs: number;
  validate: ValidateFunction;
}

export class ToolRegistry {
  private tools = new Map<string, RegisteredTool>();
  private readonly listeners = new Set<() => void>();
  revision = 0;

  get(name: string): RegisteredTool | undefined {
    return this.tools.get(name);
  }

  values(): RegisteredTool[] {
    return [...this.tools.values()].sort((left, right) =>
      left.definition.name.localeCompare(right.definition.name),
    );
  }

  count(serverId: string): number {
    return this.values().filter((tool) => tool.serverId === serverId).length;
  }

  replace(server: ServerConfig, discovered: Tool[]): void {
    const next = new Map([...this.tools].filter(([, tool]) => tool.serverId !== server.id));
    const upstreamNames = new Set<string>();
    const validatorOptions = {
      strict: false,
      allErrors: false,
      validateFormats: false,
      ownProperties: true,
    };
    const draft7 = new Ajv(validatorOptions);
    const draft2020 = new Ajv2020(validatorOptions);
    for (const original of discovered) {
      if (upstreamNames.has(original.name))
        throw new Error(`Duplicate upstream tool in ${server.id}`);
      upstreamNames.add(original.name);
      const policy: ToolPolicy | undefined = Object.hasOwn(server.tools, original.name)
        ? server.tools[original.name]
        : server.defaultPolicy;
      if (!policy?.enabled) continue;
      const name = policy.publicName ?? `${server.id}.${original.name}`;
      if (!/^[a-zA-Z0-9_.-]{1,128}$/.test(name))
        throw new Error(`Invalid public tool name in ${server.id}`);
      if (next.has(name)) throw new Error(`Duplicate public tool name: ${name}`);
      if (JSON.stringify(original.inputSchema).length > 262_144)
        throw new Error(`Input schema too large in ${server.id}`);
      let validate: ValidateFunction;
      try {
        const schema = original.inputSchema;
        const validator = String(schema.$schema ?? "").includes("2020-12") ? draft2020 : draft7;
        validate = validator.compile(schema);
      } catch {
        throw new Error(`Invalid input schema in ${server.id}`);
      }
      const definition: Tool = {
        ...structuredClone(original),
        name,
        annotations: {
          ...original.annotations,
          readOnlyHint: policy.capabilityLevel === "L0",
          destructiveHint: Number(policy.capabilityLevel.slice(1)) >= 2,
          idempotentHint: policy.idempotent,
        },
        _meta: {
          ...original._meta,
          "gateway/policy": {
            serverId: server.id,
            originalName: original.name,
            capabilityLevel: policy.capabilityLevel,
            requiredScopes: policy.requiredScopes,
            timeoutMs: policy.timeoutMs ?? server.timeoutMs,
            idempotent: policy.idempotent,
            sideEffects: policy.sideEffects,
            version: policy.version,
          },
        },
      };
      next.set(name, {
        serverId: server.id,
        upstreamName: original.name,
        definition,
        policy,
        timeoutMs: policy.timeoutMs ?? server.timeoutMs,
        validate,
      });
    }
    const hasChanges =
      next.size !== this.tools.size ||
      [...next].some(
        ([name, tool]) => !isDeepStrictEqual(tool.definition, this.tools.get(name)?.definition),
      );
    this.tools = next;
    if (hasChanges) this.changed();
  }

  remove(serverId: string): void {
    const retained = new Map([...this.tools].filter(([, tool]) => tool.serverId !== serverId));
    if (retained.size === this.tools.size) return;
    this.tools = retained;
    this.changed();
  }

  subscribe(listener: () => void): () => void {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }

  require(name: string): RegisteredTool {
    const tool = this.get(name);
    if (!tool) throw new GatewayError("TOOL_NOT_FOUND", "The requested tool is not available", 404);
    return tool;
  }

  private changed(): void {
    this.revision += 1;
    for (const listener of this.listeners) listener();
  }
}
