import { randomUUID } from "node:crypto";
import { createServer } from "node:http";
import { JsonlAuditLog } from "../audit/audit-log.js";
import { Authenticator } from "../auth/authentication.js";
import { hasScopes, type Identity } from "../auth/identity.js";
import type { GatewayConfig } from "../config/config.js";
import type { Environment } from "../config/secrets.js";
import { GatewayError, normalizeError } from "../errors.js";
import { HealthCheck } from "../health/health-check.js";
import { PolicyEngine } from "../policy/policy-engine.js";
import { McpProxy } from "../proxy/mcp-proxy.js";
import { ServerRegistry } from "../registry/server-registry.js";
import { ToolRegistry } from "../registry/tool-registry.js";
import { ToolRouter } from "../router/tool-router.js";
import { log } from "../runtime/logger.js";
import { requestContext } from "./context.js";
import {
  closeHttp,
  listenHttp,
  readJson,
  requestPath,
  secureRequest,
  sendHttpError,
  sendJson,
  validateMcpRequest,
} from "./http.js";
import { createMcpServer } from "./mcp-server.js";
import { McpTransport } from "./transport.js";

export async function createGateway(config: GatewayConfig, env: Environment = process.env) {
  const authentication = new Authenticator(config.auth, env);
  const audit = new JsonlAuditLog(config.audit.path);
  await audit.initialize();
  const registry = new ToolRegistry();
  const upstreams = new ServerRegistry(config.servers, registry, env);
  const health = new HealthCheck(upstreams, config.gateway.healthIntervalMs);
  const policy = new PolicyEngine(config.policy);
  const shutdown = new AbortController();
  const proxy = new McpProxy(upstreams, shutdown.signal);
  const router = new ToolRouter(registry, policy, proxy, audit);
  const transport = new McpTransport(
    (identity) => createMcpServer(identity, registry, policy, router),
    config.gateway,
  );
  const unsubscribe = registry.subscribe(() => transport.notifyToolsChanged());
  let closing = false;
  let closePromise: Promise<void> | undefined;
  const server = createServer((request, response) => {
    const requestId = randomUUID();
    let authenticatedIdentity: Identity | undefined;
    response.setHeader("X-Request-Id", requestId);
    void (async () => {
      secureRequest(request, response, config.gateway);
      const path = requestPath(request);
      if (closing)
        throw new GatewayError("MCP_SERVER_UNAVAILABLE", "Gateway is shutting down", 503);
      if (request.method === "GET" && path === "/health/live") {
        sendJson(response, 200, { status: "ok" });
        return;
      }
      if (request.method === "GET" && path === "/health/ready") {
        const snapshot = health.snapshot();
        sendJson(response, snapshot.ready ? 200 : 503, { status: snapshot.status });
        return;
      }
      if (path !== "/mcp" && path !== "/health") {
        sendJson(response, 404, { error: "Not found" });
        return;
      }
      if (path === "/mcp" && request.method === "OPTIONS") {
        validateMcpRequest(request, response);
        response.writeHead(204);
        response.end();
        return;
      }
      const identity = authentication.authenticate(request.headers.authorization);
      authenticatedIdentity = identity;
      if (path === "/health") {
        if (request.method !== "GET") {
          sendJson(response, 405, { error: "Method not allowed" });
          return;
        }
        if (!hasScopes(identity, ["server:read"]))
          throw new GatewayError("AUTHORIZATION_DENIED", "Health details require server:read", 403);
        sendJson(response, 200, { ...health.snapshot(), sessions: transport.sessions.size });
        return;
      }
      validateMcpRequest(request, response);
      const body =
        request.method === "POST"
          ? await readJson(request, config.gateway.requestBodyLimitBytes)
          : undefined;
      await requestContext.run({ requestId, identity }, () =>
        transport.handle(request, response, body, identity),
      );
    })().catch(async (error: unknown) => {
      const failure = normalizeError(error);
      try {
        await audit.write({
          requestId,
          identity: authenticatedIdentity?.id ?? "anonymous",
          roles: authenticatedIdentity?.roles,
          phase: "finish",
          status: failure.status === 401 || failure.status === 403 ? "denied" : "error",
          errorCode: failure.code,
        });
      } catch {
        log("error", "http_audit_write_failed", { requestId });
      }
      sendHttpError(response, failure, requestId);
    });
  });

  const close = (): Promise<void> => {
    closePromise ??= (async () => {
      closing = true;
      health.stop();
      unsubscribe();
      shutdown.abort();
      await transport.close();
      await closeHttp(server);
      await upstreams.close();
      await audit.close();
    })();
    return closePromise;
  };

  return {
    registry,
    upstreams,
    health,
    listen: async (): Promise<string> => {
      try {
        await upstreams.initialize();
        const url = await listenHttp(server, config.gateway.host, config.gateway.port);
        health.start();
        return url;
      } catch (error) {
        await close();
        throw error;
      }
    },
    close,
  };
}
