import { Buffer } from "node:buffer";
import { z } from "zod";
import { GatewayError } from "../../errors.js";
import { type CapabilityTool, defineTool } from "../types.js";

export interface BlogOptions {
  baseUrl?: string;
  token?: string;
  articlesPath?: string;
  timeoutMs?: number;
  requireAuth?: boolean;
  fetchImpl?: typeof fetch;
}

const maximumResponseBytes = 1_048_576;
const restContract = [
  "Thin REST adapter for the blog MCP HTTP API (/api/v1/mcp/articles).",
  "baseUrl must be an absolute HTTP(S) URL without credentials, query or fragment.",
  "articlesPath defaults to /api/v1/mcp/articles.",
  "Routes append articlesPath to baseUrl's existing pathname.",
  "requireAuth defaults to true; only BLOG_API_TOKEN (MCP service token) is sent as Bearer.",
  "HTTP 200 responses with envelope code != 0 are treated as tool failures.",
  "Redirects and automatic retries are disabled.",
].join(" ");

const identifierPattern = /^[A-Za-z0-9_-]+(?![\s\S])/;
const articleRef = z
  .string()
  .min(1)
  .max(128)
  .regex(identifierPattern)
  .describe("Article id (digits) or slug: 1-128 ASCII letters, digits, underscores or hyphens.");

const categoryId = z.number().int().positive().describe("Blog category id.");
const categorySlug = z
  .string()
  .min(1)
  .max(200)
  .regex(identifierPattern)
  .describe("Blog category slug.");
const tagIds = z.array(z.number().int().positive()).max(20).describe("Blog tag ids.");
const tagSlugs = z
  .array(z.string().min(1).max(200).regex(identifierPattern))
  .max(20)
  .describe("Blog tag slugs.");

interface ApiRequest {
  method: "GET" | "POST" | "PATCH";
  suffix?: string;
  query?: Record<string, string>;
  body?: Record<string, unknown>;
}

function isSafePathname(pathname: string): boolean {
  return (
    pathname.startsWith("/") &&
    !pathname.includes("//") &&
    pathname
      .split("/")
      .every((segment) => segment !== "." && segment !== ".." && !/[^A-Za-z0-9._~-]/.test(segment))
  );
}

function resolveOptions(options: BlogOptions) {
  try {
    const { baseUrl, token } = options;
    const articlesPath = options.articlesPath ?? "/api/v1/mcp/articles";
    const timeoutMs = options.timeoutMs ?? 10_000;
    if (!baseUrl || /[\s\\]/.test(baseUrl)) throw new Error();
    const parts = /^(https?):\/\/([^/?#]+)(\/[^?#]*)?$/i.exec(baseUrl);
    const basePath = parts?.[3] ?? "";
    if (!parts || parts[2]?.includes("@") || (basePath && !isSafePathname(basePath))) {
      throw new Error();
    }
    const parsedBase = new URL(baseUrl);
    if (parsedBase.username || parsedBase.password || !parsedBase.hostname) throw new Error();
    if (articlesPath.length < 2 || !isSafePathname(articlesPath)) throw new Error();
    if (!Number.isInteger(timeoutMs) || timeoutMs < 1 || timeoutMs > 120_000) throw new Error();
    if ((options.requireAuth ?? true) && !token) throw new Error();
    if (token && (token.length > 8_192 || /[^\x21-\x7e]/.test(token))) throw new Error();
    const url = new URL(
      `${parsedBase.origin}${basePath.replace(/\/$/, "")}${articlesPath.replace(/\/$/, "")}`,
    );
    return { url, token, timeoutMs, fetchImpl: options.fetchImpl ?? fetch };
  } catch {
    throw new GatewayError("MCP_SERVER_UNAVAILABLE", "Blog API configuration is unavailable", 503);
  }
}

function unavailable(): GatewayError {
  return new GatewayError("MCP_SERVER_UNAVAILABLE", "Blog API is unavailable", 503);
}

function cancelled(): GatewayError {
  return new GatewayError("TIMEOUT", "Blog API request timed out or was cancelled", 504);
}

function assertBusinessOk(data: unknown): unknown {
  if (data === null || typeof data !== "object" || Array.isArray(data)) return data;
  if (!Object.hasOwn(data, "code")) return data;
  const code = (data as { code: unknown }).code;
  if (typeof code === "number" && code !== 0) {
    throw new GatewayError("TOOL_EXECUTION_FAILED", "Blog API reported a business failure", 502);
  }
  return data;
}

async function readJsonResponse(response: Response): Promise<unknown> {
  if (response.status === 204) return null;
  const contentType = response.headers.get("content-type")?.split(";")[0]?.trim() ?? "";
  if (!/^application\/(?:[!#$%&'*+.^_`|~0-9a-z-]+\+)?json$/i.test(contentType)) throw new Error();
  if (Number(response.headers.get("content-length")) > maximumResponseBytes) throw new Error();
  if (!response.body) throw new Error();
  const reader = response.body.getReader();
  const chunks: Uint8Array[] = [];
  let totalBytes = 0;
  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      totalBytes += value.byteLength;
      if (totalBytes > maximumResponseBytes) throw new Error();
      chunks.push(value);
    }
    const text = new TextDecoder("utf-8", { fatal: true }).decode(
      Buffer.concat(chunks, totalBytes),
    );
    return JSON.parse(text, (_key: string, value: unknown) => {
      if (typeof value === "number" && !Number.isFinite(value)) throw new Error();
      return value;
    });
  } finally {
    await reader.cancel().catch(() => undefined);
    reader.releaseLock();
  }
}

async function requestApi(
  options: BlogOptions,
  request: ApiRequest,
  signal: AbortSignal,
): Promise<unknown> {
  const config = resolveOptions(options);
  config.url.pathname += request.suffix ?? "";
  if (request.query) config.url.search = new URLSearchParams(request.query).toString();
  const timeoutController = new AbortController();
  const timer = setTimeout(() => timeoutController.abort(), config.timeoutMs);
  timer.unref();
  const requestSignal = AbortSignal.any([signal, timeoutController.signal]);
  let response: Response | undefined;
  try {
    if (requestSignal.aborted) throw cancelled();
    try {
      response = await config.fetchImpl(config.url, {
        method: request.method,
        headers: {
          accept: "application/json",
          ...(config.token ? { authorization: `Bearer ${config.token}` } : {}),
          ...(request.body === undefined ? {} : { "content-type": "application/json" }),
        },
        ...(request.body === undefined ? {} : { body: JSON.stringify(request.body) }),
        signal: requestSignal,
        redirect: "error",
        credentials: "omit",
      });
    } catch {
      throw requestSignal.aborted ? cancelled() : unavailable();
    }
    if (requestSignal.aborted) throw cancelled();
    if (!response.ok) {
      if (response.status === 401 || response.status === 403) throw unavailable();
      throw new GatewayError("TOOL_EXECUTION_FAILED", "Blog API request failed", 502);
    }
    try {
      const data = assertBusinessOk(await readJsonResponse(response));
      if (requestSignal.aborted) throw cancelled();
      return data;
    } catch (error) {
      if (error instanceof GatewayError) throw error;
      if (requestSignal.aborted) throw cancelled();
      throw new GatewayError("TOOL_EXECUTION_FAILED", "Blog API returned an invalid response", 502);
    }
  } finally {
    clearTimeout(timer);
    await response?.body?.cancel().catch(() => undefined);
  }
}

function compactBody(body: Record<string, unknown>): Record<string, unknown> {
  return Object.fromEntries(
    Object.entries(body).filter(([, value]) => value !== undefined),
  );
}

export function createBlogTools(options: BlogOptions): CapabilityTool[] {
  const config = { ...options };
  return [
    defineTool({
      name: "blog.search",
      description: `Search articles with GET articlesPath?keyword=...&page=...&pageSize=.... ${restContract}`,
      inputSchema: z
        .object({
          q: z
            .string()
            .trim()
            .max(500)
            .default("")
            .describe("Search query mapped to upstream keyword; empty lists articles."),
          page: z.number().int().min(1).max(1_000_000).default(1),
          pageSize: z.number().int().min(1).max(100).default(20),
        })
        .strict(),
      capabilityLevel: "L0",
      requiredScopes: ["blog:read"],
      execute: ({ q, page, pageSize }, signal) =>
        requestApi(
          config,
          {
            method: "GET",
            query: { keyword: q, q, page: String(page), pageSize: String(pageSize) },
          },
          signal,
        ),
    }),
    defineTool({
      name: "blog.get",
      description: `Get an article with GET articlesPath/:idOrSlug. ${restContract}`,
      inputSchema: z.object({ id: articleRef }).strict(),
      capabilityLevel: "L0",
      requiredScopes: ["blog:read"],
      execute: ({ id }, signal) => requestApi(config, { method: "GET", suffix: `/${id}` }, signal),
    }),
    defineTool({
      name: "blog.create",
      description: `Create an article with POST articlesPath. Provide categoryId or categorySlug. ${restContract}`,
      inputSchema: z
        .object({
          title: z.string().trim().min(1).max(200),
          content: z
            .string()
            .min(1)
            .max(1_000_000)
            .refine((value) => value.trim().length > 0, "Content must not be blank"),
          slug: z.string().min(1).max(200).regex(identifierPattern).optional(),
          summary: z.string().max(500).optional(),
          cover: z.string().max(255).optional(),
          categoryId: categoryId.optional(),
          categorySlug: categorySlug.optional(),
          tagIds: tagIds.optional(),
          tagSlugs: tagSlugs.optional(),
          status: z.number().int().min(0).max(1).optional(),
        })
        .strict()
        .refine(
          (body) => body.categoryId !== undefined || body.categorySlug !== undefined,
          "categoryId or categorySlug is required",
        ),
      capabilityLevel: "L1",
      requiredScopes: ["blog:write"],
      idempotent: false,
      sideEffects: ["Creates an article via the Blog MCP API"],
      execute: (body, signal) =>
        requestApi(config, { method: "POST", body: compactBody(body) }, signal),
    }),
    defineTool({
      name: "blog.update",
      description: `Patch an article with PATCH articlesPath/:id. Partial fields are merged server-side. ${restContract}`,
      inputSchema: z
        .object({
          id: z
            .string()
            .regex(/^[0-9]+$/)
            .describe("Numeric article id."),
          title: z.string().trim().min(1).max(200).optional(),
          content: z
            .string()
            .min(1)
            .max(1_000_000)
            .refine((value) => value.trim().length > 0, "Content must not be blank")
            .optional(),
          slug: z.string().min(1).max(200).regex(identifierPattern).optional(),
          summary: z.string().max(500).optional(),
          cover: z.string().max(255).optional(),
          categoryId: categoryId.optional(),
          categorySlug: categorySlug.optional(),
          tagIds: tagIds.optional(),
          tagSlugs: tagSlugs.optional(),
          clearTags: z.boolean().optional(),
          status: z.number().int().min(0).max(1).optional(),
        })
        .strict()
        .refine(
          ({ id: _id, ...fields }) => Object.values(fields).some((value) => value !== undefined),
          "At least one article field must be provided",
        ),
      capabilityLevel: "L1",
      requiredScopes: ["blog:write"],
      idempotent: false,
      sideEffects: ["Updates an article via the Blog MCP API"],
      execute: ({ id, ...body }, signal) =>
        requestApi(
          config,
          { method: "PATCH", suffix: `/${id}`, body: compactBody(body) },
          signal,
        ),
    }),
    defineTool({
      name: "blog.publish",
      description: `Publish an article with POST articlesPath/:id/publish. ${restContract}`,
      inputSchema: z
        .object({
          id: z
            .string()
            .regex(/^[0-9]+$/)
            .describe("Numeric article id."),
        })
        .strict(),
      capabilityLevel: "L2",
      requiredScopes: ["blog:write"],
      idempotent: false,
      sideEffects: ["Publishes an article via the Blog MCP API"],
      execute: ({ id }, signal) =>
        requestApi(config, { method: "POST", suffix: `/${id}/publish` }, signal),
    }),
  ];
}
