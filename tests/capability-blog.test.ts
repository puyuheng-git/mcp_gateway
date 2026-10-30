import {
  createServer,
  type IncomingHttpHeaders,
  type Server,
  type ServerResponse,
} from "node:http";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { ZodError } from "zod";
import { type BlogOptions, createBlogTools } from "../src/capabilities/blog/tools.js";
import type { CapabilityTool } from "../src/capabilities/types.js";
import { type ErrorCode, GatewayError } from "../src/errors.js";

const apiToken = "independent-blog-api-token";
const privateDetails = "private-upstream-body-and-credentials";
const maximumResponseBytes = 1_048_576;
const articleId = "123";
const articleSlug = "article_123-en";
const apiData = { code: 0, message: "success", data: { id: 123, title: "API article" } };
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
    args: { id: articleSlug },
    method: "GET",
    suffix: `/${articleSlug}`,
    body: undefined,
  },
  {
    name: "blog.create",
    args: {
      title: "  New article  ",
      content: "# Body\n\nPreserve whitespace.\n",
      slug: "new-article",
      categoryId: 31,
      tagIds: [1, 2],
    },
    method: "POST",
    suffix: "",
    body: {
      title: "New article",
      content: "# Body\n\nPreserve whitespace.\n",
      slug: "new-article",
      categoryId: 31,
      tagIds: [1, 2],
    },
  },
  {
    name: "blog.update",
    args: {
      id: articleId,
      title: "Updated",
      content: "Updated body",
      slug: "updated-article",
      clearTags: true,
    },
    method: "PATCH",
    suffix: `/${articleId}`,
    body: {
      title: "Updated",
      content: "Updated body",
      slug: "updated-article",
      clearTags: true,
    },
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

describe("Blog MCP HTTP adapter", () => {
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
      if (body) {
        expect(JSON.parse(received.body)).toEqual(body);
      } else {
        expect(received.body).toBe("");
      }
      if (name === "blog.search") {
        expect(Object.fromEntries(url.searchParams)).toEqual({
          keyword: "Go & Node/中文?draft=#",
          q: "Go & Node/中文?draft=#",
          page: "2",
          pageSize: "7",
        });
      }
    },
  );

  it("uses keyword defaults and the MCP articles path", async () => {
    await execute("blog.search", {});
    expect(requests.map(({ url }) => url)).toEqual([
      "/api/v1/mcp/articles?keyword=&q=&page=1&pageSize=20",
    ]);
  });

  it("requires categoryId or categorySlug on create", async () => {
    await expect(
      execute("blog.create", { title: "Title", content: "Content" }),
    ).rejects.toBeInstanceOf(ZodError);
    expect(requests).toHaveLength(0);
  });

  it("accepts categorySlug on create", async () => {
    await execute("blog.create", {
      title: "Title",
      content: "Content",
      categorySlug: "tech-insight",
    });
    expect(JSON.parse(requests[0]?.body ?? "null")).toEqual({
      title: "Title",
      content: "Content",
      categorySlug: "tech-insight",
    });
  });

  it.each([{ title: "Title only" }, { content: "Content only" }, { clearTags: true }])(
    "patches only the supplied field (%j)",
    async (fields) => {
      await expect(execute("blog.update", { id: articleId, ...fields })).resolves.toEqual(apiData);
      expect(requests[0]?.method).toBe("PATCH");
      expect(requests[0]?.url).toBe(`/api/v1/mcp/articles/${articleId}`);
      expect(JSON.parse(requests[0]?.body ?? "null")).toEqual(fields);
    },
  );

  it("treats envelope code != 0 as a tool failure without leaking details", async () => {
    respond = (response) => {
      response.writeHead(200, { "content-type": "application/json" });
      response.end(JSON.stringify({ code: 40400, message: privateDetails, data: {} }));
    };
    await expectFailure(
      execute("blog.get", { id: articleSlug }),
      "TOOL_EXECUTION_FAILED",
      502,
    );
  });

  it.each([undefined, apiToken])(
    "allows explicitly unauthenticated APIs without inventing a token (%s)",
    async (token) => {
      await execute("blog.search", {}, { requireAuth: false, token });
      expect(requests).toHaveLength(1);
      expect(requests[0]?.headers.authorization).toBe(token ? `Bearer ${token}` : undefined);
    },
  );

  it("rejects invalid create/update/publish arguments before HTTP", async () => {
    const cases: Array<[string, unknown]> = [
      ["blog.create", { title: "Title", content: "body" }],
      ["blog.create", { title: "", content: "body", categoryId: 1 }],
      ["blog.update", { id: articleId }],
      ["blog.update", { id: articleSlug, title: "Valid" }],
      ["blog.publish", { id: articleSlug }],
      ["blog.publish", { id: articleId, token: "inbound" }],
    ];
    for (const [name, args] of cases) {
      await expect(execute(name, args)).rejects.toBeInstanceOf(ZodError);
    }
    expect(requests).toHaveLength(0);
  });

  it("rejects oversized declared length and non-json payloads", async () => {
    respond = (response) => {
      response.writeHead(200, {
        "content-type": "application/json",
        "content-length": String(maximumResponseBytes + 1),
      });
      response.end("{}");
    };
    await expectFailure(execute("blog.search", {}), "TOOL_EXECUTION_FAILED", 502);

    respond = (response) => {
      response.writeHead(200, { "content-type": "text/plain" });
      response.end("ok");
    };
    await expectFailure(execute("blog.search", {}), "TOOL_EXECUTION_FAILED", 502);
  });

  it.each([401, 403])("maps %s to unavailable without leaking body", async (status) => {
    respond = (response) => {
      response.writeHead(status, { "content-type": "application/json" });
      response.end(JSON.stringify({ message: privateDetails }));
    };
    await expectFailure(execute("blog.search", {}), "MCP_SERVER_UNAVAILABLE", 503);
  });

  it.each([500, 502, 504])("maps upstream %s to tool failure", async (status) => {
    respond = (response) => {
      response.writeHead(status, { "content-type": "application/json" });
      response.end(JSON.stringify({ message: privateDetails }));
    };
    await expectFailure(execute("blog.search", {}), "TOOL_EXECUTION_FAILED", 502);
  });

  it("cancels in-flight requests when the caller aborts", async () => {
    const controller = new AbortController();
    respond = () => {
      controller.abort();
    };
    await expectFailure(
      tool("blog.search").execute({}, controller.signal),
      "TIMEOUT",
      504,
    );
  });
});
