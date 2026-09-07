import {
  createServer,
  type IncomingHttpHeaders,
  type Server,
  type ServerResponse,
} from "node:http";
import { gzipSync } from "node:zlib";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { ZodError } from "zod";
import { type BlogOptions, createBlogTools } from "../src/capabilities/blog/tools.js";
import type { CapabilityTool } from "../src/capabilities/types.js";
import { type ErrorCode, GatewayError } from "../src/errors.js";

const apiToken = "independent-blog-api-token";
const privateDetails = "private-upstream-body-and-credentials";
const maximumResponseBytes = 1_048_576;
const articleId = "article_123-en";
const apiData = { id: articleId, title: "API article", extra: { tags: ["Go"], published: false } };
const toolCalls = [
  {
    name: "blog.search",
    args: { q: "Go & Node/中文?draft=#", page: 2, pageSize: 7 },
    method: "GET",
    suffix: "",
    body: undefined,
  },
  {
    name: "blog.get",
    args: { id: articleId },
    method: "GET",
    suffix: `/${articleId}`,
    body: undefined,
  },
  {
    name: "blog.create",
    args: {
      title: "  New article  ",
      content: "# Body\n\nPreserve whitespace.\n",
      slug: "new-article",
      tags: ["Go", "Node"],
    },
    method: "POST",
    suffix: "",
    body: {
      title: "New article",
      content: "# Body\n\nPreserve whitespace.\n",
      slug: "new-article",
      tags: ["Go", "Node"],
    },
  },
  {
    name: "blog.update",
    args: {
      id: articleId,
      title: "Updated",
      content: "Updated body",
      slug: "updated-article",
      tags: [],
    },
    method: "PATCH",
    suffix: `/${articleId}`,
    body: { title: "Updated", content: "Updated body", slug: "updated-article", tags: [] },
  },
  {
    name: "blog.publish",
    args: { id: articleId },
    method: "POST",
    suffix: `/${articleId}/publish`,
    body: undefined,
  },
] as const;

interface ReceivedRequest {
  method: string | undefined;
  url: string;
  headers: IncomingHttpHeaders;
  body: string;
}

let server: Server;
let baseUrl: string;
let requests: ReceivedRequest[];
let respond: (response: ServerResponse) => void;

beforeEach(async () => {
  requests = [];
  respond = (response) => {
    response.writeHead(200, { "content-type": "application/json" });
    response.end(JSON.stringify(apiData));
  };
  server = createServer((request, response) => {
    let body = "";
    request.setEncoding("utf8");
    request.on("data", (chunk: string) => {
      body += chunk;
    });
    request.on("end", () => {
      requests.push({
        method: request.method,
        url: request.url ?? "",
        headers: request.headers,
        body,
      });
      respond(response);
    });
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const address = server.address();
  if (!address || typeof address === "string") throw new Error("Local HTTP fixture did not bind");
  baseUrl = `http://127.0.0.1:${address.port}`;
});

afterEach(async () => {
  const closed = new Promise<void>((resolve, reject) => {
    server.close((error) => (error ? reject(error) : resolve()));
  });
  server.closeAllConnections();
  await closed;
});

function tools(options: BlogOptions = {}): CapabilityTool[] {
  return createBlogTools({ baseUrl, token: apiToken, ...options });
}

function tool(name: string, options: BlogOptions = {}): CapabilityTool {
  const selected = tools(options).find((candidate) => candidate.name === name);
  if (!selected) throw new Error(`Missing Blog tool: ${name}`);
  return selected;
}

function execute(name: string, args: unknown, options: BlogOptions = {}): Promise<unknown> {
  return tool(name, options).execute(args, new AbortController().signal);
}

async function expectFailure(result: Promise<unknown>, code: ErrorCode, status: number) {
  const failure: unknown = await result.catch((error: unknown) => error);
  expect(failure).toBeInstanceOf(GatewayError);
  expect(failure).toMatchObject({ code, status, retryable: false });
  const serialized = `${String(failure)} ${JSON.stringify(failure)}`;
  for (const secret of [apiToken, privateDetails, baseUrl]) {
    expect(serialized).not.toContain(secret);
  }
}

describe("Blog configurable REST adapter", () => {
  it("discovers all five tools without API configuration", () => {
    const discovered = createBlogTools({});
    expect(
      discovered.map(({ name, capabilityLevel, requiredScopes, idempotent }) => ({
        name,
        capabilityLevel,
        requiredScopes,
        idempotent,
      })),
    ).toEqual([
      {
        name: "blog.search",
        capabilityLevel: "L0",
        requiredScopes: ["blog:read"],
        idempotent: true,
      },
      { name: "blog.get", capabilityLevel: "L0", requiredScopes: ["blog:read"], idempotent: true },
      {
        name: "blog.create",
        capabilityLevel: "L1",
        requiredScopes: ["blog:write"],
        idempotent: false,
      },
      {
        name: "blog.update",
        capabilityLevel: "L1",
        requiredScopes: ["blog:write"],
        idempotent: false,
      },
      {
        name: "blog.publish",
        capabilityLevel: "L2",
        requiredScopes: ["blog:write"],
        idempotent: false,
      },
    ]);
    for (const discoveredTool of discovered) {
      expect(discoveredTool.sideEffects.length > 0).toBe(discoveredTool.capabilityLevel !== "L0");
    }
    expect(requests).toHaveLength(0);
  });

  it.each(toolCalls)("fails closed on missing configuration for $name", async ({ name, args }) => {
    for (const options of [{}, { token: apiToken }, { baseUrl }, { baseUrl, token: "" }]) {
      const selected = createBlogTools(options).find((candidate) => candidate.name === name);
      expect(selected).toBeDefined();
      if (!selected) throw new Error("Missing discoverable tool");
      await expectFailure(
        selected.execute(args, new AbortController().signal),
        "MCP_SERVER_UNAVAILABLE",
        503,
      );
    }
    expect(requests).toHaveLength(0);
  });

  it.each(toolCalls)(
    "maps $name to the configured HTTP method, path, token and body",
    async ({ name, args, method, suffix, body }) => {
      await expect(
        execute(name, args, { baseUrl: `${baseUrl}/go-service/`, articlesPath: "/v2/articles/" }),
      ).resolves.toEqual(apiData);
      expect(requests).toHaveLength(1);
      const received = requests[0];
      expect(received).toBeDefined();
      if (!received) throw new Error("Request was not received");
      const url = new URL(received.url, baseUrl);
      expect(url.pathname).toBe(`/go-service/v2/articles${suffix}`);
      expect(received.method).toBe(method);
      expect(received.headers.authorization).toBe(`Bearer ${apiToken}`);
      expect(received.headers.accept).toBe("application/json");
      expect(received.headers.cookie).toBeUndefined();
      if (body) {
        expect(received.headers["content-type"]).toBe("application/json");
        expect(JSON.parse(received.body)).toEqual(body);
      } else {
        expect(received.body).toBe("");
        expect(received.headers["content-type"]).toBeUndefined();
      }
      expect(Object.fromEntries(url.searchParams)).toEqual(
        name === "blog.search" ? { q: "Go & Node/中文?draft=#", page: "2", pageSize: "7" } : {},
      );
    },
  );

  it("uses bounded search defaults and the default articles path", async () => {
    await execute("blog.search", {});
    expect(requests.map(({ url }) => url)).toEqual(["/api/articles?q=&page=1&pageSize=20"]);
  });

  it("does not invent optional article fields when creating an article", async () => {
    const article = { title: "Title", content: "Content" };
    await expect(execute("blog.create", article)).resolves.toEqual(apiData);
    expect(requests).toHaveLength(1);
    expect(JSON.parse(requests[0]?.body ?? "null")).toEqual(article);
  });

  it.each([
    { title: "Title only" },
    { content: "Content only" },
    { slug: "slug-only" },
    { tags: [] },
  ])("patches only the supplied field, including clearing tags (%#)", async (fields) => {
    await expect(execute("blog.update", { id: articleId, ...fields })).resolves.toEqual(apiData);
    expect(requests).toHaveLength(1);
    expect(requests[0]?.method).toBe("PATCH");
    expect(requests[0]?.url).toBe(`/api/articles/${articleId}`);
    expect(JSON.parse(requests[0]?.body ?? "null")).toEqual(fields);
  });

  it.each([
    ["", "/api/articles", "/api/articles"],
    ["/", "/api/articles/", "/api/articles"],
    ["/go", "/api/articles", "/go/api/articles"],
    ["/go/", "/v2/posts/", "/go/v2/posts"],
    ["/go/v1.0/", "/content~archive/posts", "/go/v1.0/content~archive/posts"],
  ])(
    "preserves base pathname %s when appending %s",
    async (basePath, articlesPath, expectedPath) => {
      await execute(
        "blog.get",
        { id: articleId },
        { baseUrl: `${baseUrl}${basePath}`, articlesPath },
      );
      expect(requests.map(({ url }) => url)).toEqual([`${expectedPath}/${articleId}`]);
    },
  );

  it.each([undefined, apiToken])(
    "allows explicitly unauthenticated APIs without inventing a token (%s)",
    async (token) => {
      await execute("blog.search", {}, { requireAuth: false, token });
      expect(requests).toHaveLength(1);
      expect(requests[0]?.headers.authorization).toBe(token ? `Bearer ${token}` : undefined);
    },
  );

  it("uses the injected fetch implementation with redirects disabled and cancellation attached", async () => {
    let observed: RequestInit | undefined;
    const fetchImpl: typeof fetch = (input, init) => {
      observed = init;
      return fetch(input, init);
    };
    await expect(execute("blog.get", { id: articleId }, { fetchImpl })).resolves.toEqual(apiData);
    expect(observed).toMatchObject({
      redirect: "error",
      credentials: "omit",
      signal: expect.any(AbortSignal),
    });
    expect(requests).toHaveLength(1);
  });

  it.each([
    ["blog.search", { q: 42 }],
    ["blog.search", { q: "a".repeat(501) }],
    ["blog.search", { page: 0 }],
    ["blog.search", { page: 1.5 }],
    ["blog.search", { page: "2" }],
    ["blog.search", { page: 1_000_001 }],
    ["blog.search", { pageSize: 0 }],
    ["blog.search", { pageSize: 101 }],
    ["blog.search", { authorization: "inbound-gateway-token" }],
    ["blog.get", {}],
    ["blog.create", { title: "", content: "body" }],
    ["blog.create", { title: "  ", content: "body" }],
    ["blog.create", { title: "a".repeat(201), content: "body" }],
    ["blog.create", { title: "Title" }],
    ["blog.create", { title: "Title", content: "" }],
    ["blog.create", { title: "Title", content: " \n " }],
    ["blog.create", { title: "Title", content: "a".repeat(1_000_001) }],
    ["blog.create", { title: "Title", content: "body", slug: "../escape" }],
    ["blog.create", { title: "Title", content: "body", slug: "a".repeat(201) }],
    ["blog.create", { title: "Title", content: "body", tags: [""] }],
    ["blog.create", { title: "Title", content: "body", tags: ["a".repeat(65)] }],
    ["blog.create", { title: "Title", content: "body", tags: Array(21).fill("tag") }],
    ["blog.create", { title: "Title", content: "body", token: "inbound-gateway-token" }],
    ["blog.update", { id: articleId }],
    ["blog.update", { id: articleId, title: undefined }],
    ["blog.update", { id: articleId, tags: undefined }],
    ["blog.update", { id: articleId, title: null }],
    ["blog.update", { id: articleId, content: "" }],
    ["blog.update", { id: articleId, title: "Valid", injected: true }],
    ["blog.publish", { id: articleId, token: "inbound-gateway-token" }],
  ] as const)("rejects invalid %s arguments before HTTP", async (name, args) => {
    await expect(execute(name, args)).rejects.toBeInstanceOf(ZodError);
    expect(requests).toHaveLength(0);
  });

  it.each(["blog.get", "blog.update", "blog.publish"])(
    "rejects unsafe identifiers in %s",
    async (name) => {
      for (const id of [
        "",
        ".",
        "..",
        "../escape",
        "a/b",
        "a\\b",
        "%2e%2e",
        "%252e%252e",
        "a%2fb",
        "a?token=secret",
        "a#fragment",
        "https://example.invalid",
        "a\n",
        "中文",
        "a".repeat(129),
      ]) {
        await expect(
          execute(name, { id, ...(name === "blog.update" ? { title: "Valid" } : {}) }),
        ).rejects.toBeInstanceOf(ZodError);
      }
      expect(requests).toHaveLength(0);
    },
  );

  it("accepts the documented schema bounds without dropping optional fields", async () => {
    const article = {
      title: "a".repeat(200),
      content: "b".repeat(1_000_000),
      slug: "c".repeat(200),
      tags: Array(20).fill("d".repeat(64)),
    };
    await execute("blog.create", article);
    await execute("blog.search", { q: "q".repeat(500), page: 1_000_000, pageSize: 100 });
    await execute("blog.get", { id: "a".repeat(128) });
    expect(requests).toHaveLength(3);
    expect(JSON.parse(requests[0]?.body ?? "null")).toEqual(article);
    expect(new URL(requests[1]?.url ?? "", baseUrl).searchParams.get("pageSize")).toBe("100");
    expect(requests[2]?.url).toBe(`/api/articles/${"a".repeat(128)}`);
  });

  it.each([
    "http://user:private-upstream-body-and-credentials@127.0.0.1",
    "http://@127.0.0.1",
    "file:///tmp/blog",
    "ftp://127.0.0.1/blog",
    "//127.0.0.1/blog",
    "http:////127.0.0.1/blog",
    "not-a-url",
  ])("rejects unsafe base URL %s lazily", async (unsafeUrl) => {
    expect(tools({ baseUrl: unsafeUrl })).toHaveLength(5);
    await expectFailure(
      execute("blog.create", { title: "Title", content: "body" }, { baseUrl: unsafeUrl }),
      "MCP_SERVER_UNAVAILABLE",
      503,
    );
    expect(requests).toHaveLength(0);
  });

  it.each([
    "/../escape",
    "/a/./articles",
    "/%2e%2e/escape",
    "/%252e%252e/escape",
    "//articles",
    "/a\\articles",
    "/api?token=secret",
    "/api#secret",
    "/api\n",
    "/%2farticles",
  ])("rejects unsafe base path %s before URL normalization", async (basePath) => {
    await expectFailure(
      execute("blog.get", { id: articleId }, { baseUrl: `${baseUrl}${basePath}` }),
      "MCP_SERVER_UNAVAILABLE",
      503,
    );
    expect(requests).toHaveLength(0);
  });

  it.each([
    "",
    "/",
    "articles",
    "https://example.invalid/articles",
    "//example.invalid/articles",
    "/../articles",
    "/a/./articles",
    "/api//articles",
    "/%2e%2e/articles",
    "/%252e%252e/articles",
    "/api%2farticles",
    "/api\\articles",
    "/api?token=secret",
    "/api#secret",
    "/api\n",
  ])("rejects unsafe articles path %s", async (articlesPath) => {
    await expectFailure(
      execute("blog.publish", { id: articleId }, { articlesPath }),
      "MCP_SERVER_UNAVAILABLE",
      503,
    );
    expect(requests).toHaveLength(0);
  });

  it.each([0, -1, 1.5, 120_001, Number.NaN, Number.POSITIVE_INFINITY])(
    "rejects an invalid timeout of %s without HTTP",
    async (timeoutMs) => {
      await expectFailure(execute("blog.search", {}, { timeoutMs }), "MCP_SERVER_UNAVAILABLE", 503);
      expect(requests).toHaveLength(0);
    },
  );

  it.each([" ", "token\r\nX-Injected: secret", "token\t", "非ASCII", "a".repeat(8_193)])(
    "rejects an unsafe API token (%#)",
    async (token) => {
      await expectFailure(execute("blog.search", {}, { token }), "MCP_SERVER_UNAVAILABLE", 503);
      expect(requests).toHaveLength(0);
    },
  );

  it.each([400, 401, 403, 404, 409, 422, 429, 500, 502, 503])(
    "redacts upstream HTTP %s and never retries any tool",
    async (status) => {
      respond = (response) => {
        response.writeHead(status, {
          "content-type": "application/json",
          "www-authenticate": `Bearer ${apiToken}`,
        });
        response.end(JSON.stringify({ error: privateDetails, token: apiToken, url: baseUrl }));
      };
      for (const [index, call] of toolCalls.entries()) {
        await expectFailure(
          execute(call.name, call.args),
          status === 401 || status === 403 ? "MCP_SERVER_UNAVAILABLE" : "TOOL_EXECUTION_FAILED",
          status === 401 || status === 403 ? 503 : 502,
        );
        expect(requests).toHaveLength(index + 1);
      }
    },
  );

  it("does not read or wait for a failing upstream response body", async () => {
    respond = (response) => {
      response.writeHead(500, { "content-type": "application/json" });
      response.flushHeaders();
    };
    await expectFailure(
      execute("blog.publish", { id: articleId }, { timeoutMs: 150 }),
      "TOOL_EXECUTION_FAILED",
      502,
    );
    expect(requests).toHaveLength(1);
  });

  it.each([301, 302, 303, 307, 308])(
    "never follows HTTP %s redirects for any tool",
    async (status) => {
      respond = (response) => {
        response.writeHead(status, { location: `${baseUrl}/redirect-target?secret=${apiToken}` });
        response.end(privateDetails);
      };
      for (const [index, call] of toolCalls.entries()) {
        await expectFailure(execute(call.name, call.args), "MCP_SERVER_UNAVAILABLE", 503);
        expect(requests).toHaveLength(index + 1);
      }
      expect(requests.every(({ url }) => !url.startsWith("/redirect-target"))).toBe(true);
    },
  );

  it("sanitizes connection failures without retrying reads or writes", async () => {
    respond = (response) => {
      response.destroy();
    };
    for (const [index, call] of toolCalls.entries()) {
      await expectFailure(execute(call.name, call.args), "MCP_SERVER_UNAVAILABLE", 503);
      expect(requests).toHaveLength(index + 1);
    }
  });

  it("does not trust raw exceptions even when injected fetch throws a GatewayError", async () => {
    const fetchImpl: typeof fetch = async (input, init) => {
      const response = await fetch(input, init);
      await response.body?.cancel();
      throw new GatewayError(
        "AUTHENTICATION_FAILED",
        `${privateDetails} ${apiToken} ${baseUrl}`,
        401,
      );
    };
    await expectFailure(
      execute("blog.create", { title: "Title", content: "body" }, { fetchImpl }),
      "MCP_SERVER_UNAVAILABLE",
      503,
    );
    expect(requests).toHaveLength(1);
  });

  it.each(["headers", "body"])(
    "times out stalled response %s without retries for any tool",
    async (phase) => {
      respond = (response) => {
        if (phase === "body") {
          response.writeHead(200, { "content-type": "application/json" });
          response.write('{"pending":');
        }
      };
      for (const [index, call] of toolCalls.entries()) {
        await expectFailure(execute(call.name, call.args, { timeoutMs: 100 }), "TIMEOUT", 504);
        expect(requests).toHaveLength(index + 1);
      }
    },
  );

  it("honors caller cancellation while reading the response body and redacts the reason", async () => {
    let markRequested: (() => void) | undefined;
    const requested = new Promise<void>((resolve) => {
      markRequested = resolve;
    });
    respond = (response) => {
      response.writeHead(200, { "content-type": "application/json" });
      response.write('{"pending":');
      markRequested?.();
    };
    const controller = new AbortController();
    const result = tool("blog.publish").execute({ id: articleId }, controller.signal);
    const assertion = expectFailure(result, "TIMEOUT", 504);
    await requested;
    controller.abort(new Error(`${apiToken} ${privateDetails}`));
    await assertion;
    expect(requests).toHaveLength(1);
  });

  it("does not send already cancelled calls", async () => {
    const controller = new AbortController();
    controller.abort();
    for (const call of toolCalls) {
      await expect(tool(call.name).execute(call.args, controller.signal)).rejects.toThrow();
    }
    expect(requests).toHaveLength(0);
  });

  it.each([
    ["application/json; charset=utf-8", { nested: [true, null, 3] }],
    ["Application/JSON", ["one", "two"]],
    ["application/vnd.blog.article+json", "article"],
    ["application/vnd.blog+article+json", "article"],
    ["application/vnd.blog^article+json", { id: articleId }],
    ["application/problem+json", null],
    ["application/json", false],
  ])("returns unwrapped JSON data for %s (%#)", async (contentType, data) => {
    respond = (response) => {
      response.writeHead(200, { "content-type": contentType as string });
      response.end(JSON.stringify(data));
    };
    await expect(execute("blog.get", { id: articleId })).resolves.toEqual(data);
    expect(requests).toHaveLength(1);
  });

  it("returns null for a successful HTTP 204 rather than fabricating an article", async () => {
    respond = (response) => {
      response.writeHead(204);
      response.end();
    };
    await expect(execute("blog.publish", { id: articleId })).resolves.toBeNull();
    expect(requests).toHaveLength(1);
  });

  it.each([
    ["text/html", `<html>${privateDetails}</html>`],
    ["application/jsonp", JSON.stringify(apiData)],
    ["text/json", JSON.stringify(apiData)],
    [undefined, JSON.stringify(apiData)],
    ["application/json", `{${privateDetails}`],
    ["application/json", ""],
    ["application/json", Buffer.from([0xff])],
    ["application/json", '{"number":1e400}'],
  ])(
    "rejects invalid API response content without mock success (%#)",
    async (contentType, body) => {
      respond = (response) => {
        response.writeHead(
          200,
          typeof contentType === "string" ? { "content-type": contentType } : {},
        );
        response.end(body);
      };
      await expectFailure(execute("blog.get", { id: articleId }), "TOOL_EXECUTION_FAILED", 502);
      expect(requests).toHaveLength(1);
    },
  );

  it.each(["declared", "chunked", "gzip"])(
    "enforces response byte limits for %s bodies",
    async (encoding) => {
      const body = Buffer.from(JSON.stringify({ text: "界".repeat(400_000) }));
      expect(body.byteLength).toBeGreaterThan(maximumResponseBytes);
      respond = (response) => {
        if (encoding === "declared") {
          response.writeHead(200, {
            "content-type": "application/json",
            "content-length": body.byteLength,
          });
          response.end(body);
        } else if (encoding === "gzip") {
          response.writeHead(200, {
            "content-type": "application/json",
            "content-encoding": "gzip",
          });
          response.end(gzipSync(body));
        } else {
          response.writeHead(200, { "content-type": "application/json" });
          response.write(body.subarray(0, 65_536));
          response.end(body.subarray(65_536));
        }
      };
      await expectFailure(execute("blog.get", { id: articleId }), "TOOL_EXECUTION_FAILED", 502);
      expect(requests).toHaveLength(1);
    },
  );

  it("accepts a valid JSON response exactly at the byte limit", async () => {
    const data = "a".repeat(maximumResponseBytes - 2);
    respond = (response) => {
      response.writeHead(200, { "content-type": "application/json" });
      response.end(JSON.stringify(data));
    };
    await expect(execute("blog.get", { id: articleId })).resolves.toBe(data);
    expect(requests).toHaveLength(1);
  });
});
