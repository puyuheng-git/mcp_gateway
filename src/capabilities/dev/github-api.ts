import { GatewayError } from "../../errors.js";

export interface GitHubRequestOptions {
  apiUrl?: string;
  token?: string;
  fetchImpl?: typeof fetch;
  timeoutMs?: number;
}

export async function githubRequest(
  options: GitHubRequestOptions,
  path: string,
  method: "GET" | "POST",
  signal: AbortSignal,
  body?: unknown,
): Promise<unknown> {
  let url: URL;
  try {
    url = new URL(options.apiUrl ?? "https://api.github.com");
    if (
      !["http:", "https:"].includes(url.protocol) ||
      url.username ||
      url.password ||
      url.search ||
      url.hash
    )
      throw new Error();
    url.pathname = `${url.pathname.replace(/\/$/, "")}${path.split("?")[0]}`;
    url.search = path.includes("?") ? path.slice(path.indexOf("?") + 1) : "";
    if (!options.token || /[^\x21-\x7e]/.test(options.token)) throw new Error();
  } catch {
    throw new GatewayError(
      "MCP_SERVER_UNAVAILABLE",
      "GitHub API configuration is unavailable",
      503,
    );
  }
  const requestSignal = AbortSignal.any([signal, AbortSignal.timeout(options.timeoutMs ?? 10_000)]);
  let response: Response | undefined;
  try {
    requestSignal.throwIfAborted();
    response = await (options.fetchImpl ?? fetch)(url, {
      method,
      headers: {
        Accept: "application/vnd.github+json",
        Authorization: `Bearer ${options.token}`,
        "X-GitHub-Api-Version": "2022-11-28",
        ...(body === undefined ? {} : { "Content-Type": "application/json" }),
      },
      ...(body === undefined ? {} : { body: JSON.stringify(body) }),
      redirect: "error",
      signal: requestSignal,
    });
    if (!response.ok) throw new Error("Upstream response failed");
    if (response.status === 204) return null;
    if (
      !response.headers.get("content-type")?.toLowerCase().includes("json") ||
      !response.body ||
      Number(response.headers.get("content-length")) > 1_048_576
    )
      throw new Error();
    const reader = response.body.getReader();
    const chunks: Uint8Array[] = [];
    let bytes = 0;
    try {
      while (true) {
        const chunk = await reader.read();
        if (chunk.done) break;
        bytes += chunk.value.byteLength;
        if (bytes > 1_048_576) throw new Error();
        chunks.push(chunk.value);
      }
      return JSON.parse(
        new TextDecoder("utf-8", { fatal: true }).decode(Buffer.concat(chunks, bytes)),
      ) as unknown;
    } finally {
      await reader.cancel().catch(() => undefined);
      reader.releaseLock();
    }
  } catch {
    if (requestSignal.aborted)
      throw new GatewayError("TIMEOUT", "GitHub API request timed out or was cancelled", 504);
    throw new GatewayError("TOOL_EXECUTION_FAILED", "GitHub API request failed", 502);
  } finally {
    await response?.body?.cancel().catch(() => undefined);
  }
}
