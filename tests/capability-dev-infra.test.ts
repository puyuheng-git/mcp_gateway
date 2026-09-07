import { execFile } from "node:child_process";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { createServer } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";
import { afterEach, describe, expect, it } from "vitest";
import type { CommandRunner } from "../src/capabilities/command.js";
import { createDevTools } from "../src/capabilities/dev/tools.js";
import { createInfraTools } from "../src/capabilities/infra/tools.js";
import type { CapabilityTool } from "../src/capabilities/types.js";
import { closeHttp, listenHttp } from "../src/server/http.js";

const run = promisify(execFile);
const cleanups: (() => Promise<unknown>)[] = [];
const signal = () => new AbortController().signal;

function call(tools: CapabilityTool[], name: string, args: unknown = {}) {
  const tool = tools.find((entry) => entry.name === name);
  if (!tool) throw new Error(`Missing test tool ${name}`);
  return tool.execute(args, signal());
}

afterEach(async () => {
  for (const cleanup of cleanups.splice(0).reverse()) await cleanup();
});

describe("Dev capabilities", () => {
  it("reads status and log from an explicitly configured real repository", async () => {
    const directory = await mkdtemp(join(tmpdir(), "gateway-git-"));
    cleanups.push(() => rm(directory, { recursive: true, force: true }));
    await run("git", ["init", directory]);
    await writeFile(join(directory, "tracked.txt"), "first\n");
    await run("git", ["-C", directory, "add", "tracked.txt"]);
    await run("git", [
      "-C",
      directory,
      "-c",
      "user.name=Gateway Test",
      "-c",
      "user.email=gateway-test@example.invalid",
      "-c",
      "commit.gpgsign=false",
      "-c",
      `core.hooksPath=${process.platform === "win32" ? "NUL" : "/dev/null"}`,
      "commit",
      "-m",
      "Fixture commit",
    ]);
    await writeFile(join(directory, "untracked.txt"), "new\n");
    const tools = createDevTools({ repositories: { fixture: directory } });
    expect(await call(tools, "git.status", { repository: "fixture" })).toMatchObject({
      repository: "fixture",
      status: expect.stringContaining("untracked.txt"),
    });
    expect(await call(tools, "git.log", { repository: "fixture", limit: 1 })).toMatchObject({
      commits: [expect.objectContaining({ subject: "Fixture commit" })],
    });
    await expect(call(tools, "git.status", { repository: directory })).rejects.toThrow();
    await expect(call(tools, "git.status", { repository: "unknown" })).rejects.toThrow(
      "not allowed",
    );
  });

  it("uses a fixed fast-forward pull command and never accepts user flags", async () => {
    const directory = await mkdtemp(join(tmpdir(), "gateway-git-args-"));
    cleanups.push(() => rm(directory, { recursive: true, force: true }));
    const commands: { executable: string; args: readonly string[] }[] = [];
    const runCommand: CommandRunner = async (executable, args) => {
      commands.push({ executable, args });
      return { stdout: "Already up to date.\n", stderr: "" };
    };
    const tools = createDevTools({ repositories: { fixture: directory }, runCommand });
    await call(tools, "git.pull", { repository: "fixture" });
    expect(commands).toHaveLength(1);
    expect(commands[0]?.executable).toBe("git");
    expect(commands[0]?.args).toContain("--ff-only");
    expect(commands[0]?.args).toContain("--no-recurse-submodules");
    await expect(
      call(tools, "git.pull", { repository: "fixture", command: "malicious" }),
    ).rejects.toThrow();
    expect(commands).toHaveLength(1);
  });

  it("calls only allowlisted GitHub repositories and sends the expected PR body", async () => {
    const requests: { method?: string; url?: string; authorization?: string; body: unknown }[] = [];
    const api = createServer(async (request, response) => {
      const chunks: Buffer[] = [];
      for await (const chunk of request) chunks.push(Buffer.from(chunk));
      const raw = Buffer.concat(chunks).toString();
      requests.push({
        method: request.method,
        url: request.url,
        authorization: request.headers.authorization,
        body: raw ? JSON.parse(raw) : undefined,
      });
      response.writeHead(200, { "Content-Type": "application/json" });
      response.end(JSON.stringify(request.method === "POST" ? { number: 7 } : [{ number: 3 }]));
    });
    const apiUrl = await listenHttp(api, "127.0.0.1", 0);
    cleanups.push(() => closeHttp(api));
    const tools = createDevTools({
      repositories: {},
      githubApiUrl: new URL("/", apiUrl).href,
      githubToken: "separate-github-token",
      githubAllowedRepositories: ["owner/project"],
    });
    await expect(call(tools, "github.issue.list", { repository: "other/project" })).rejects.toThrow(
      "not allowed",
    );
    expect(requests).toHaveLength(0);
    await call(tools, "github.issue.list", { repository: "owner/project", limit: 5 });
    await call(tools, "github.pr.list", { repository: "owner/project", state: "closed" });
    expect(
      await call(tools, "github.pr.create", {
        repository: "owner/project",
        title: "A pull request",
        head: "feature",
        base: "main",
      }),
    ).toEqual({ number: 7 });
    expect(requests[0]).toMatchObject({
      method: "GET",
      authorization: "Bearer separate-github-token",
    });
    expect(requests[0]?.url).toContain("/repos/owner/project/issues?");
    expect(requests[0]?.url).toContain("per_page=5");
    expect(requests[1]?.url).toContain("/pulls?");
    expect(requests[2]).toMatchObject({
      method: "POST",
      url: "/repos/owner/project/pulls",
      body: { title: "A pull request", head: "feature", base: "main", draft: false },
    });
  });

  it("redacts GitHub errors and does not retry failed mutations", async () => {
    let calls = 0;
    const fetchImpl: typeof fetch = async () => {
      calls += 1;
      return new Response("credential-secret raw upstream body", { status: 503 });
    };
    const tools = createDevTools({
      repositories: {},
      githubAllowedRepositories: ["owner/project"],
      githubToken: "credential-secret",
      fetchImpl,
    });
    await expect(
      call(tools, "github.pr.create", {
        repository: "owner/project",
        title: "Title",
        head: "feature",
        base: "main",
      }),
    ).rejects.toMatchObject({
      code: "TOOL_EXECUTION_FAILED",
      retryable: false,
      message: expect.not.stringContaining("credential-secret"),
    });
    expect(calls).toBe(1);
  });
});

describe("Infra capabilities", () => {
  it("returns actual system and filesystem measurements", async () => {
    const tools = createInfraTools({ diskPath: tmpdir() });
    expect(await call(tools, "server.info")).toMatchObject({
      platform: process.platform,
      architecture: process.arch,
    });
    const memory = (await call(tools, "server.memory")) as {
      totalBytes: number;
      freeBytes: number;
    };
    expect(memory.totalBytes).toBeGreaterThan(0);
    expect(memory.freeBytes).toBeLessThanOrEqual(memory.totalBytes);
    const disk = (await call(tools, "server.disk")) as {
      totalBytes: number;
      availableBytes: number;
    };
    expect(disk.totalBytes).toBeGreaterThan(0);
    expect(disk.availableBytes).toBeLessThanOrEqual(disk.totalBytes);
  });

  it("denies unconfigured and injected container names before execution", async () => {
    const commands: string[][] = [];
    const runCommand: CommandRunner = async (_executable, args) => {
      commands.push([...args]);
      return { stdout: "", stderr: "" };
    };
    const tools = createInfraTools({ allowedContainers: ["blog-api"], runCommand });
    for (const container of ["other", "--help", "blog-api;whoami", "blog-api\n"]) {
      await expect(call(tools, "docker.restart", { container })).rejects.toThrow();
    }
    await expect(call(createInfraTools({ runCommand }), "docker.ps")).rejects.toThrow(
      "not configured",
    );
    expect(commands).toHaveLength(0);
  });

  it("filters Docker listing and constrains logs and restart arguments", async () => {
    const commands: string[][] = [];
    const runCommand: CommandRunner = async (executable, args) => {
      expect(executable).toBe("docker");
      commands.push([...args]);
      return {
        stdout:
          args[0] === "ps"
            ? '{"ID":"a","Names":"blog-api","Status":"Up"}\n{"ID":"b","Names":"private-db","Status":"Up"}\n'
            : "output\n",
        stderr: "",
      };
    };
    const tools = createInfraTools({ allowedContainers: ["blog-api"], runCommand });
    expect(await call(tools, "docker.ps")).toEqual({
      containers: [{ ID: "a", Names: "blog-api", Status: "Up" }],
    });
    await call(tools, "docker.logs", { container: "blog-api", tail: 25 });
    await call(tools, "docker.restart", { container: "blog-api" });
    expect(commands[1]).toEqual(["logs", "--timestamps", "--tail", "25", "--", "blog-api"]);
    expect(commands[2]).toEqual(["restart", "--timeout", "10", "--", "blog-api"]);
    await expect(
      call(tools, "docker.logs", { container: "blog-api", tail: 1001 }),
    ).rejects.toThrow();
  });
});
