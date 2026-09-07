import type { CallToolResult } from "@modelcontextprotocol/server";
import type { AuditWriter } from "../audit/audit-log.js";
import type { Identity } from "../auth/identity.js";
import { GatewayError, normalizeError, toolError } from "../errors.js";
import type { PolicyEngine } from "../policy/policy-engine.js";
import type { McpProxy } from "../proxy/mcp-proxy.js";
import type { RegisteredTool, ToolRegistry } from "../registry/tool-registry.js";
import { log } from "../runtime/logger.js";

export class ToolRouter {
  constructor(
    private readonly registry: ToolRegistry,
    private readonly policy: PolicyEngine,
    private readonly proxy: McpProxy,
    private readonly audit: AuditWriter,
  ) {}

  async call(
    identity: Identity,
    name: string,
    args: Record<string, unknown>,
    requestId: string,
    signal: AbortSignal,
  ): Promise<CallToolResult> {
    const started = performance.now();
    let tool: RegisteredTool | undefined;
    const context = () => ({
      requestId,
      identity: identity.id,
      roles: identity.roles,
      tool: name,
      serverId: tool?.serverId,
      capabilityLevel: tool?.policy.capabilityLevel,
    });
    try {
      tool = this.registry.require(name);
      this.policy.check(identity, tool.policy);
      if (!tool.validate(args))
        throw new GatewayError(
          "INVALID_ARGUMENT",
          "Tool arguments do not match the input schema",
          400,
        );
      signal.throwIfAborted();
      await this.audit.write({ ...context(), phase: "start", status: "started" });
      const result = await this.proxy.call(tool, args, signal);
      await this.audit.write({
        ...context(),
        phase: "finish",
        status: "success",
        durationMs: Math.round(performance.now() - started),
      });
      return { ...result, _meta: { ...result._meta, "gateway/requestId": requestId } };
    } catch (error) {
      let failure = normalizeError(error);
      try {
        await this.audit.write({
          ...context(),
          phase: "finish",
          status: ["AUTHORIZATION_DENIED", "POLICY_DENIED"].includes(failure.code)
            ? "denied"
            : "error",
          errorCode: failure.code,
          durationMs: Math.round(performance.now() - started),
        });
      } catch {
        log("error", "audit_write_failed", { requestId });
        failure = new GatewayError("AUDIT_UNAVAILABLE", "Audit storage is unavailable", 503);
      }
      return toolError(failure, requestId, name);
    }
  }
}
