import { realpath } from "node:fs/promises";
import { z } from "zod";
import { GatewayError } from "../../errors.js";
import { type CommandRunner, runCommand as executeCommand } from "../command.js";
import { type CapabilityTool, defineTool } from "../types.js";
import { githubRequest } from "./github-api.js";

export interface DevOptions {
  repositories: Record<string, string>;
  githubToken?: string;
  githubAllowedRepositories?: string[];
  githubApiUrl?: string;
  fetchImpl?: typeof fetch;
  commandTimeoutMs?: number;
  runCommand?: CommandRunner;
}

const repositoryAlias = z
  .string()
  .min(1)
  .max(64)
  .regex(/^[A-Za-z0-9_.-]+(?![\s\S])/);
const githubRepository = z
  .string()
  .max(200)
  .regex(/^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+(?![\s\S])/);
const branchName = z
  .string()
  .min(1)
  .max(200)
  .regex(/^[A-Za-z0-9_./:-]+(?![\s\S])/);
const listFields = {
  repository: githubRepository,
  state: z.enum(["open", "closed", "all"]).default("open"),
  limit: z.number().int().min(1).max(100).default(20),
  page: z.number().int().min(1).max(1000).default(1),
};

export function createDevTools(options: DevOptions): CapabilityTool[] {
  const runCommand = options.runCommand ?? executeCommand;
  const allowedGitHub = new Set(options.githubAllowedRepositories ?? []);

  async function git(repository: string, args: string[], signal: AbortSignal) {
    if (!Object.hasOwn(options.repositories, repository))
      throw new GatewayError("AUTHORIZATION_DENIED", "Repository is not allowed", 403);
    let path: string;
    try {
      path = await realpath(options.repositories[repository] ?? "");
    } catch {
      throw new GatewayError("MCP_SERVER_UNAVAILABLE", "Configured repository is unavailable", 503);
    }
    return runCommand(
      "git",
      [
        "-C",
        path,
        "-c",
        `core.hooksPath=${process.platform === "win32" ? "NUL" : "/dev/null"}`,
        "-c",
        "core.fsmonitor=false",
        ...args,
      ],
      { signal, timeoutMs: options.commandTimeoutMs ?? 20_000 },
    );
  }

  function github(
    repository: string,
    route: string,
    method: "GET" | "POST",
    signal: AbortSignal,
    body?: unknown,
  ) {
    if (!allowedGitHub.has(repository))
      throw new GatewayError("AUTHORIZATION_DENIED", "GitHub repository is not allowed", 403);
    const path = `/repos/${repository.split("/").map(encodeURIComponent).join("/")}/${route}`;
    return githubRequest(
      {
        apiUrl: options.githubApiUrl,
        token: options.githubToken,
        fetchImpl: options.fetchImpl,
        timeoutMs: options.commandTimeoutMs,
      },
      path,
      method,
      signal,
      body,
    );
  }

  return [
    defineTool({
      name: "git.status",
      description: "Read Git status for a configured repository alias.",
      inputSchema: z.object({ repository: repositoryAlias }).strict(),
      capabilityLevel: "L0",
      requiredScopes: ["git:read"],
      execute: async ({ repository }, signal) => {
        const result = await git(
          repository,
          ["status", "--porcelain=v1", "--branch", "--untracked-files=normal"],
          signal,
        );
        return { repository, status: result.stdout.trimEnd() };
      },
    }),
    defineTool({
      name: "git.log",
      description: "Read recent Git commits from a configured repository alias.",
      inputSchema: z
        .object({
          repository: repositoryAlias,
          limit: z.number().int().min(1).max(100).default(10),
        })
        .strict(),
      capabilityLevel: "L0",
      requiredScopes: ["git:read"],
      execute: async ({ repository, limit }, signal) => {
        const result = await git(
          repository,
          ["log", `--max-count=${limit}`, "--format=%H%x09%aI%x09%an%x09%s", "--"],
          signal,
        );
        return {
          repository,
          commits: result.stdout
            .trim()
            .split("\n")
            .filter(Boolean)
            .map((line) => {
              const [commit, date, author, ...subject] = line.split("\t");
              return { commit, date, author, subject: subject.join("\t") };
            }),
        };
      },
    }),
    defineTool({
      name: "git.pull",
      description:
        "Fast-forward pull the configured repository's existing remote and branch. Never retries or runs hooks.",
      inputSchema: z.object({ repository: repositoryAlias }).strict(),
      capabilityLevel: "L1",
      requiredScopes: ["git:write"],
      sideEffects: ["git_worktree_update"],
      execute: async ({ repository }, signal) => ({
        repository,
        output: (
          await git(repository, ["pull", "--ff-only", "--no-recurse-submodules"], signal)
        ).stdout.trimEnd(),
      }),
    }),
    defineTool({
      name: "github.issue.list",
      description:
        "List issues in an explicitly allowlisted GitHub owner/repository; pull requests are excluded.",
      inputSchema: z.object(listFields).strict(),
      capabilityLevel: "L0",
      requiredScopes: ["github:read"],
      execute: async ({ repository, state, limit, page }, signal) => {
        const result = await github(
          repository,
          `issues?${new URLSearchParams({ state, per_page: String(limit), page: String(page) })}`,
          "GET",
          signal,
        );
        if (!Array.isArray(result))
          throw new GatewayError("TOOL_EXECUTION_FAILED", "Unexpected GitHub issue response", 502);
        return result.filter(
          (issue: unknown) => issue && typeof issue === "object" && !("pull_request" in issue),
        );
      },
    }),
    defineTool({
      name: "github.pr.list",
      description: "List pull requests in an explicitly allowlisted GitHub owner/repository.",
      inputSchema: z.object(listFields).strict(),
      capabilityLevel: "L0",
      requiredScopes: ["github:read"],
      execute: ({ repository, state, limit, page }, signal) =>
        github(
          repository,
          `pulls?${new URLSearchParams({ state, per_page: String(limit), page: String(page) })}`,
          "GET",
          signal,
        ),
    }),
    defineTool({
      name: "github.pr.create",
      description: "Create a pull request in an allowlisted GitHub repository. Never retries.",
      inputSchema: z
        .object({
          repository: githubRepository,
          title: z.string().trim().min(1).max(256),
          head: branchName,
          base: branchName,
          body: z.string().max(65_000).optional(),
          draft: z.boolean().default(false),
        })
        .strict(),
      capabilityLevel: "L1",
      requiredScopes: ["github:write"],
      sideEffects: ["pull_request_created"],
      execute: ({ repository, ...body }, signal) =>
        github(repository, "pulls", "POST", signal, body),
    }),
  ];
}
