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
  "Configurable REST adapter for an existing Go HTTP API; the real Go API contract is not verified.",
  "baseUrl must be an absolute HTTP(S) URL without credentials, query or fragment.",
  "articlesPath defaults to /api/articles and must start with a single slash and name a collection.",
  "Routes append articlesPath to baseUrl's existing pathname, removing trailing slashes from both; a leading slash never resets the base path.",
  "Path segments allow ASCII letters, digits, dot, underscore, tilde and hyphen; dot-only traversal segments, percent escapes, backslashes and repeated slashes are rejected.",
  "requireAuth defaults to true; only the independently configured API token is sent as Bearer, never a gateway token.",
  "Missing or invalid configuration fails at execution, not discovery. No mock success or database access is provided.",
  "Responses must be UTF-8 application/json or application/*+json, at most 1 MiB after decompression, and are returned unchanged; HTTP 204 returns null.",
  "timeoutMs defaults to 10000 and must be an integer from 1 through 120000; it covers headers and body and honors caller cancellation.",
  "Redirects and automatic retries are disabled for every call.",
].join(" ");

const identifierPattern = /^[A-Za-z0-9_-]+(?![\s\S])/;
const articleId = z
  .string()
  .min(1)
  .max(128)
  .regex(identifierPattern)
  .describe("Article identifier: 1-128 ASCII letters, digits, underscores or hyphens.");
const articleFields = {
  title: z.string().trim().min(1).max(200).describe("Article title, trimmed, 1-200 characters."),
  content: z
    .string()
    .min(1)
    .max(1_000_000)
    .refine((value) => value.trim().length > 0, "Content must not be blank")
    .describe("Article content, 1-1000000 characters; original whitespace is preserved."),
  slug: z
    .string()
    .min(1)
    .max(200)
    .regex(identifierPattern)
    .optional()
    .describe("Optional slug: 1-200 ASCII letters, digits, underscores or hyphens."),
  tags: z
    .array(z.string().trim().min(1).max(64))
    .max(20)
    .optional()
    .describe("Optional list of up to 20 tags, each trimmed and 1-64 characters; [] clears tags."),
};

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
    const articlesPath = options.articlesPath ?? "/api/articles";
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
      const data = await readJsonResponse(response);
      if (requestSignal.aborted) throw cancelled();
      return data;
    } catch {
      if (requestSignal.aborted) throw cancelled();
      throw new GatewayError("TOOL_EXECUTION_FAILED", "Blog API returned an invalid response", 502);
    }
  } finally {
    clearTimeout(timer);
    await response?.body?.cancel().catch(() => undefined);
  }
}

export function createBlogTools(options: BlogOptions): CapabilityTool[] {
  const config = { ...options };
  return [
    defineTool({
      name: "blog.search",
      description: `Search articles with GET articlesPath?q=...&page=...&pageSize=.... ${restContract}`,
      inputSchema: z
        .object({
          q: z
            .string()
            .trim()
            .max(500)
            .default("")
            .describe("Search query, up to 500 characters; empty lists articles."),
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
            query: { q, page: String(page), pageSize: String(pageSize) },
          },
          signal,
        ),
    }),
    defineTool({
      name: "blog.get",
      description: `Get an article with GET articlesPath/:id. ${restContract}`,
      inputSchema: z.object({ id: articleId }).strict(),
      capabilityLevel: "L0",
      requiredScopes: ["blog:read"],
      execute: ({ id }, signal) => requestApi(config, { method: "GET", suffix: `/${id}` }, signal),
    }),
    defineTool({
      name: "blog.create",
      description: `Create an article with POST articlesPath and a JSON body {title, content, slug?, tags?}. ${restContract}`,
      inputSchema: z.object(articleFields).strict(),
      capabilityLevel: "L1",
      requiredScopes: ["blog:write"],
      idempotent: false,
      sideEffects: ["Creates an article via the Blog API"],
      execute: (body, signal) => requestApi(config, { method: "POST", body }, signal),
    }),
    defineTool({
      name: "blog.update",
      description: `Update an article with PATCH articlesPath/:id and a JSON body containing only supplied title/content/slug/tags fields, never id. At least one field is required. ${restContract}`,
      inputSchema: z
        .object({
          id: articleId,
          title: articleFields.title.optional(),
          content: articleFields.content.optional(),
          slug: articleFields.slug,
          tags: articleFields.tags,
        })
        .strict()
        .refine(
          ({ title, content, slug, tags }) =>
            [title, content, slug, tags].some((value) => value !== undefined),
          "At least one article field must be provided",
        ),
      capabilityLevel: "L1",
      requiredScopes: ["blog:write"],
      idempotent: false,
      sideEffects: ["Updates an article via the Blog API"],
      execute: ({ id, ...body }, signal) =>
        requestApi(config, { method: "PATCH", suffix: `/${id}`, body }, signal),
    }),
    defineTool({
      name: "blog.publish",
      description: `Publish an article with POST articlesPath/:id/publish and no request body. ${restContract}`,
      inputSchema: z.object({ id: articleId }).strict(),
      capabilityLevel: "L2",
      requiredScopes: ["blog:write"],
      idempotent: false,
      sideEffects: ["Publishes an article via the Blog API"],
      execute: ({ id }, signal) =>
        requestApi(config, { method: "POST", suffix: `/${id}/publish` }, signal),
    }),
  ];
}
