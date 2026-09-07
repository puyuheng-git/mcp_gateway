import type { CallToolResult } from "@modelcontextprotocol/client";
import { GatewayError } from "../errors.js";
import type { ServerRegistry } from "../registry/server-registry.js";
import type { RegisteredTool } from "../registry/tool-registry.js";

export class McpProxy {
  constructor(
    private readonly servers: ServerRegistry,
    private readonly shutdown: AbortSignal,
  ) {}

  async call(
    tool: RegisteredTool,
    args: Record<string, unknown>,
    cancelled: AbortSignal,
  ): Promise<CallToolResult> {
    const client = this.servers.client(tool.serverId);
    const signal = AbortSignal.any([cancelled, this.shutdown, AbortSignal.timeout(tool.timeoutMs)]);
    try {
      signal.throwIfAborted();
      const result = await client.callTool(
        { name: tool.upstreamName, arguments: args },
        {
          toolDefinition: { ...tool.definition, name: tool.upstreamName },
          signal,
          timeout: tool.timeoutMs + 100,
          maxTotalTimeout: tool.timeoutMs + 100,
          resetTimeoutOnProgress: false,
        },
      );
      if (result.isError)
        throw new GatewayError(
          "TOOL_EXECUTION_FAILED",
          "The upstream tool reported an execution failure",
          502,
        );
      return result;
    } catch (error) {
      if (signal.aborted)
        throw new GatewayError(
          "TIMEOUT",
          "The upstream call timed out or was cancelled; execution may have occurred",
          504,
        );
      if (error instanceof GatewayError) throw error;
      throw new GatewayError(
        "TOOL_EXECUTION_FAILED",
        "The upstream tool call failed; execution may have occurred",
        502,
      );
    }
  }
}
