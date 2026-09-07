import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { getDefaultEnvironment } from "@modelcontextprotocol/client/stdio";
import { GatewayError } from "../errors.js";

export interface CommandOptions {
  signal: AbortSignal;
  timeoutMs?: number;
}

export type CommandRunner = (
  executable: "git" | "docker",
  args: readonly string[],
  options: CommandOptions,
) => Promise<{ stdout: string; stderr: string }>;

const execute = promisify(execFile);

export const runCommand: CommandRunner = async (executable, args, options) => {
  try {
    options.signal.throwIfAborted();
    return await execute(executable, [...args], {
      encoding: "utf8",
      windowsHide: true,
      shell: false,
      signal: options.signal,
      timeout: options.timeoutMs ?? 10_000,
      maxBuffer: 2_097_152,
      env: {
        ...getDefaultEnvironment(),
        GIT_TERMINAL_PROMPT: "0",
        GIT_SSH_COMMAND: "ssh -oBatchMode=yes",
      },
    });
  } catch (error) {
    const failure = error as NodeJS.ErrnoException & { killed?: boolean };
    if (options.signal.aborted || failure.killed || failure.name === "AbortError") {
      throw new GatewayError(
        "TIMEOUT",
        "The system operation timed out or was cancelled; execution may have occurred",
        504,
      );
    }
    if (failure.code === "ENOENT")
      throw new GatewayError(
        "MCP_SERVER_UNAVAILABLE",
        `Required executable ${executable} is unavailable`,
        503,
      );
    throw new GatewayError("TOOL_EXECUTION_FAILED", `The ${executable} operation failed`, 502);
  }
};
