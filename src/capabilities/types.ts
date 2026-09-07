import type { z } from "zod";
import type { CapabilityLevel } from "../auth/identity.js";

export interface CapabilityTool {
  name: string;
  description: string;
  inputSchema: z.ZodType;
  capabilityLevel: CapabilityLevel;
  requiredScopes: string[];
  idempotent: boolean;
  sideEffects: string[];
  execute(args: unknown, signal: AbortSignal): Promise<unknown>;
}

export function defineTool<Schema extends z.ZodType>(definition: {
  name: string;
  description: string;
  inputSchema: Schema;
  capabilityLevel: CapabilityLevel;
  requiredScopes: string[];
  idempotent?: boolean;
  sideEffects?: string[];
  execute(args: z.output<Schema>, signal: AbortSignal): Promise<unknown>;
}): CapabilityTool {
  return {
    ...definition,
    idempotent: definition.idempotent ?? definition.capabilityLevel === "L0",
    sideEffects: definition.sideEffects ?? [],
    execute: async (args, signal) => {
      signal.throwIfAborted();
      return definition.execute(definition.inputSchema.parse(args ?? {}), signal);
    },
  };
}
