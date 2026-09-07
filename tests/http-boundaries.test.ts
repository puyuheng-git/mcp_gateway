import { mkdtemp, rm } from "node:fs/promises";
import { request as httpRequest, type IncomingHttpHeaders } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { createCapabilityHttpServer } from "../src/capabilities/runtime.js";
import { parseConfig } from "../src/config/config.js";
import { createGateway } from "../src/server/gateway.js";
import { testTokens } from "./helpers/mcp-fixture.js";

function unfinishedRequest(url: string, method: string, token: string, bytes = 2048) {
  return new Promise<{ status: number; headers: IncomingHttpHeaders }>((resolve, reject) => {
    const request = httpRequest(url, {
      method,
      headers: {
        Authorization: `Bearer ${token}`,
        "Content-Type": "application/json",
        "Transfer-Encoding": "chunked",
      },
    });
    const timeout = setTimeout(() => {
      request.destroy();
      reject(new Error("Server waited for an unbounded request body before rejecting it"));
    }, 1500);
    request.on("error", (error) => {
      clearTimeout(timeout);
      reject(error);
    });
    request.on("response", (response) => {
      response.resume();
      response.on("end", () => {
        clearTimeout(timeout);
        resolve({ status: response.statusCode ?? 0, headers: response.headers });
        request.destroy();
      });
    });
    request.write("x".repeat(bytes));
  });
}

describe.each(["gateway", "capability"] as const)("%s HTTP request boundaries", (surface) => {
  let directory: string;
  let url: string;
  let token: string;
  const cleanups: (() => Promise<unknown>)[] = [];
  beforeEach(async () => {
    directory = await mkdtemp(join(tmpdir(), "gateway-http-boundaries-"));
    const capability = createCapabilityHttpServer({
      name: "http-fixture",
      token: testTokens.upstream,
      tools: [],
      allowedOrigins: ["https://client.example"],
    });
    cleanups.push(capability.close);
    url = await capability.listen();
    token = testTokens.upstream;
    if (surface === "gateway") {
      const environment = { ADMIN: testTokens.admin, UPSTREAM: testTokens.upstream };
      const gateway = await createGateway(
        parseConfig(
          {
            gateway: {
              port: 0,
              requestBodyLimitBytes: 1024,
              allowedOrigins: ["https://client.example"],
            },
            auth: { identities: [{ id: "admin", tokenEnv: "ADMIN", roles: ["admin"] }] },
            audit: { path: join(directory, "audit.jsonl") },
            servers: [
              {
                id: "fixture",
                name: "Fixture",
                transport: "streamable-http",
                url,
                authTokenEnv: "UPSTREAM",
              },
            ],
          },
          environment,
        ),
        environment,
      );
      cleanups.push(gateway.close);
      url = await gateway.listen();
      token = testTokens.admin;
    }
  });
  afterEach(async () => {
    for (const cleanup of cleanups.splice(0).reverse()) await cleanup();
    await rm(directory, { recursive: true, force: true });
  });

  it.each(["PUT", "PATCH", "HEAD", "GET", "DELETE", "OPTIONS"])(
    "rejects unfinished %s bodies without waiting for end-of-stream",
    async (method) => {
      const result = await unfinishedRequest(url, method, token);
      expect(result.status).toBe(["PUT", "PATCH", "HEAD"].includes(method) ? 405 : 400);
      expect(result.headers.connection).toBe("close");
    },
  );

  it("returns a bounded POST error even when chunked input never ends", async () => {
    const limit = surface === "gateway" ? 1024 : 1_048_576;
    const result = await unfinishedRequest(url, "POST", token, limit + 65_536);
    expect(result.status).toBe(413);
    expect(result.headers.connection).toBe("close");
  });

  it("allows the CORS headers sent by a modern MCP browser client", async () => {
    const response = await fetch(url, {
      method: "OPTIONS",
      headers: {
        Origin: "https://client.example",
        "Access-Control-Request-Method": "POST",
        "Access-Control-Request-Headers":
          "authorization,content-type,mcp-protocol-version,mcp-method,mcp-name",
      },
    });
    expect(response.status).toBe(204);
    expect(response.headers.get("access-control-allow-origin")).toBe("https://client.example");
    const headers = response.headers
      .get("access-control-allow-headers")
      ?.toLowerCase()
      .split(/,\s*/);
    expect(headers).toEqual(
      expect.arrayContaining([
        "authorization",
        "content-type",
        "mcp-protocol-version",
        "mcp-method",
        "mcp-name",
      ]),
    );
  });
});
