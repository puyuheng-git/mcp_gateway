import { statfs } from "node:fs/promises";
import { arch, cpus, freemem, hostname, platform, release, totalmem, uptime } from "node:os";
import { z } from "zod";
import { GatewayError } from "../../errors.js";
import { type CommandRunner, runCommand as executeCommand } from "../command.js";
import { type CapabilityTool, defineTool } from "../types.js";

export interface InfraOptions {
  allowedContainers?: string[];
  diskPath?: string;
  commandTimeoutMs?: number;
  runCommand?: CommandRunner;
}

const containerName = z
  .string()
  .min(1)
  .max(128)
  .regex(/^[A-Za-z0-9][A-Za-z0-9_.-]*(?![\s\S])/);
const emptyInput = z.object({}).strict();

export function createInfraTools(options: InfraOptions = {}): CapabilityTool[] {
  const allowedContainers = new Set(
    (options.allowedContainers ?? []).map((name) => containerName.parse(name)),
  );
  const runCommand = options.runCommand ?? executeCommand;

  function requireContainers(container?: string) {
    if (allowedContainers.size === 0)
      throw new GatewayError("POLICY_DENIED", "Docker containers are not configured", 403);
    if (container && !allowedContainers.has(container))
      throw new GatewayError("AUTHORIZATION_DENIED", "Container is not allowed", 403);
  }

  function docker(args: string[], signal: AbortSignal) {
    return runCommand("docker", args, { signal, timeoutMs: options.commandTimeoutMs ?? 20_000 });
  }

  return [
    defineTool({
      name: "server.info",
      description:
        "Read the MCP host's or container's operating-system information; never returns environment secrets.",
      inputSchema: emptyInput,
      capabilityLevel: "L0",
      requiredScopes: ["server:read"],
      execute: async () => ({
        hostname: hostname(),
        platform: platform(),
        architecture: arch(),
        release: release(),
        cpuCount: cpus().length,
        uptimeSeconds: Math.floor(uptime()),
        nodeVersion: process.versions.node,
      }),
    }),
    defineTool({
      name: "server.disk",
      description: "Read filesystem capacity for the administrator-configured disk path.",
      inputSchema: emptyInput,
      capabilityLevel: "L0",
      requiredScopes: ["server:read"],
      execute: async () => {
        try {
          const stats = await statfs(options.diskPath ?? ".", { bigint: true });
          return {
            totalBytes: Number(stats.blocks * stats.bsize),
            freeBytes: Number(stats.bfree * stats.bsize),
            availableBytes: Number(stats.bavail * stats.bsize),
          };
        } catch {
          throw new GatewayError(
            "TOOL_EXECUTION_FAILED",
            "Cannot read the configured filesystem",
            502,
          );
        }
      },
    }),
    defineTool({
      name: "server.memory",
      description: "Read the MCP host's memory totals in bytes.",
      inputSchema: emptyInput,
      capabilityLevel: "L0",
      requiredScopes: ["server:read"],
      execute: async () => {
        const totalBytes = totalmem();
        const freeBytes = freemem();
        return { totalBytes, freeBytes, usedBytes: totalBytes - freeBytes };
      },
    }),
    defineTool({
      name: "docker.ps",
      description: "List only explicitly allowlisted Docker containers.",
      inputSchema: emptyInput,
      capabilityLevel: "L0",
      requiredScopes: ["docker:read"],
      execute: async (_args, signal) => {
        requireContainers();
        const result = await docker(["ps", "--all", "--format", "{{json .}}"], signal);
        try {
          const containers = result.stdout
            .split("\n")
            .filter((line) => line.trim())
            .map((line) => JSON.parse(line) as Record<string, unknown>);
          return {
            containers: containers.filter(
              (container) =>
                typeof container.Names === "string" && allowedContainers.has(container.Names),
            ),
          };
        } catch {
          throw new GatewayError(
            "TOOL_EXECUTION_FAILED",
            "Unexpected Docker listing response",
            502,
          );
        }
      },
    }),
    defineTool({
      name: "docker.logs",
      description: "Read a bounded number of log lines from an allowlisted container.",
      inputSchema: z
        .object({ container: containerName, tail: z.number().int().min(1).max(1000).default(100) })
        .strict(),
      capabilityLevel: "L0",
      requiredScopes: ["docker:read"],
      execute: async ({ container, tail }, signal) => {
        requireContainers(container);
        const result = await docker(
          ["logs", "--timestamps", "--tail", String(tail), "--", container],
          signal,
        );
        return { container, logs: result.stdout, stderr: result.stderr };
      },
    }),
    defineTool({
      name: "docker.restart",
      description:
        "Restart one allowlisted container with a fixed 10-second stop timeout. Never retries.",
      inputSchema: z.object({ container: containerName }).strict(),
      capabilityLevel: "L2",
      requiredScopes: ["docker:write"],
      sideEffects: ["container_restart"],
      execute: async ({ container }, signal) => {
        requireContainers(container);
        const result = await docker(["restart", "--timeout", "10", "--", container], signal);
        return { container, restarted: true, output: result.stdout.trimEnd() };
      },
    }),
  ];
}
