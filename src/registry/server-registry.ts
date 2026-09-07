import {
  Client,
  type McpSubscription,
  StreamableHTTPClientTransport,
  type Tool,
  type Transport,
} from "@modelcontextprotocol/client";
import { getDefaultEnvironment, StdioClientTransport } from "@modelcontextprotocol/client/stdio";
import type { ServerConfig } from "../config/config.js";
import { type Environment, readSecret } from "../config/secrets.js";
import { GatewayError } from "../errors.js";
import { log } from "../runtime/logger.js";
import type { ToolRegistry } from "./tool-registry.js";

interface ServerEntry {
  config: ServerConfig;
  client?: Client;
  subscription?: McpSubscription;
  status: "starting" | "healthy" | "unavailable" | "disabled";
  lastCheckedAt?: string;
  errorCode?: string;
}

export class ServerRegistry {
  private readonly entries = new Map<string, ServerEntry>();
  private readonly pending = new Map<string, Promise<void>>();
  private closed = false;

  constructor(
    servers: ServerConfig[],
    private readonly tools: ToolRegistry,
    private readonly env: Environment = process.env,
  ) {
    for (const config of servers)
      this.entries.set(config.id, { config, status: config.enabled ? "starting" : "disabled" });
  }

  async initialize(): Promise<void> {
    await Promise.all(
      [...this.entries.values()]
        .filter((entry) => entry.config.enabled)
        .map((entry) => this.refresh(entry.config.id)),
    );
  }

  client(id: string): Client {
    const entry = this.entries.get(id);
    if (!entry?.client || entry.status !== "healthy") {
      throw new GatewayError(
        "MCP_SERVER_UNAVAILABLE",
        "The upstream MCP server is unavailable",
        503,
        true,
      );
    }
    return entry.client;
  }

  status() {
    return [...this.entries.values()].map((entry) => ({
      id: entry.config.id,
      name: entry.config.name,
      transport: entry.config.transport,
      enabled: entry.config.enabled,
      required: entry.config.required,
      status: entry.status,
      toolCount: this.tools.count(entry.config.id),
      lastCheckedAt: entry.lastCheckedAt,
      errorCode: entry.errorCode,
    }));
  }

  async refresh(id: string): Promise<void> {
    const existing = this.pending.get(id);
    if (existing) return existing;
    const entry = this.entries.get(id);
    if (!entry?.config.enabled || this.closed) return;
    const task = this.checkEntry(entry).finally(() => {
      this.pending.delete(id);
    });
    this.pending.set(id, task);
    return task;
  }

  async check(): Promise<void> {
    await Promise.all([...this.entries.keys()].map((id) => this.refresh(id)));
  }

  private makeTransport(config: ServerConfig): Transport {
    if (config.transport === "streamable-http") {
      const headers: Record<string, string> = {};
      if (config.authTokenEnv)
        headers.Authorization = `Bearer ${readSecret(config.authTokenEnv, this.env)}`;
      return new StreamableHTTPClientTransport(new URL(config.url), {
        requestInit: { headers, redirect: "error" },
      });
    }
    return new StdioClientTransport({
      command: config.command,
      args: config.args,
      cwd: config.cwd,
      env: { ...getDefaultEnvironment(), ...config.env },
      stderr: "ignore",
      maxBufferSize: 8_388_608,
    });
  }

  private trackSubscription(entry: ServerEntry, client: Client, subscription: McpSubscription) {
    entry.subscription = subscription;
    void subscription.closed.then(() => {
      if (entry.client === client && entry.subscription === subscription)
        entry.subscription = undefined;
    });
  }

  private async restoreSubscription(entry: ServerEntry, client: Client, signal: AbortSignal) {
    if (
      this.closed ||
      entry.client !== client ||
      entry.subscription ||
      !client.getServerCapabilities()?.tools?.listChanged
    )
      return;
    const opening = new AbortController();
    const cancelOpening = () => opening.abort(signal.reason);
    if (signal.aborted) cancelOpening();
    signal.addEventListener("abort", cancelOpening, { once: true });
    try {
      const subscription = await client.listen(
        { toolsListChanged: true },
        { timeout: entry.config.timeoutMs, signal: opening.signal },
      );
      if (this.closed || entry.client !== client) {
        await subscription.close();
        return;
      }
      this.trackSubscription(entry, client, subscription);
    } catch (error) {
      if (signal.aborted) throw error;
      log("warn", "upstream_subscription_unavailable", { serverId: entry.config.id });
    } finally {
      signal.removeEventListener("abort", cancelOpening);
    }
  }

  private async checkEntry(entry: ServerEntry): Promise<void> {
    const { config } = entry;
    const signal = AbortSignal.timeout(config.timeoutMs);
    try {
      let client = entry.client;
      if (!client) {
        client = new Client(
          { name: "mcp-gateway", version: "1.0.0" },
          {
            capabilities: {},
            versionNegotiation: { mode: "auto" },
            listChanged: {
              tools: {
                autoRefresh: false,
                debounceMs: 0,
                onChanged: () => {
                  void this.refresh(config.id);
                },
              },
            },
          },
        );
        const connected = client;
        entry.client = connected;
        connected.onerror = () => log("warn", "upstream_protocol_error", { serverId: config.id });
        connected.onclose = () => {
          if (entry.client !== connected) return;
          entry.client = undefined;
          entry.subscription = undefined;
          entry.status = "unavailable";
          entry.errorCode = "MCP_SERVER_UNAVAILABLE";
          this.tools.remove(config.id);
        };
        await connected.connect(this.makeTransport(config), { timeout: config.timeoutMs, signal });
        if (connected.autoOpenedSubscription)
          this.trackSubscription(entry, connected, connected.autoOpenedSubscription);
      } else if (client.getDiscoverResult()) {
        await client.discover({ timeout: config.timeoutMs, signal });
        await this.restoreSubscription(entry, client, signal);
      } else {
        await client.ping({ timeout: config.timeoutMs, signal });
      }
      const discovered: Tool[] = [];
      if (client.getServerCapabilities()?.tools) {
        let cursor: string | undefined;
        const cursors = new Set<string>();
        do {
          const page = await client.listTools(cursor ? { cursor } : undefined, {
            timeout: config.timeoutMs,
            signal,
            cacheMode: "refresh",
          });
          discovered.push(...page.tools);
          if (discovered.length > 1000 || cursors.size > 100)
            throw new Error("Discovery limit exceeded");
          cursor = page.nextCursor;
          if (cursor && cursors.has(cursor)) throw new Error("Repeated discovery cursor");
          if (cursor) cursors.add(cursor);
        } while (cursor);
      }
      if (this.closed || entry.client !== client) return;
      this.tools.replace(config, discovered);
      entry.status = "healthy";
      entry.errorCode = undefined;
    } catch {
      const client = entry.client;
      entry.client = undefined;
      entry.subscription = undefined;
      entry.status = "unavailable";
      entry.errorCode = signal.aborted ? "TIMEOUT" : "MCP_SERVER_UNAVAILABLE";
      this.tools.remove(config.id);
      await client?.close().catch(() => undefined);
      if (!this.closed)
        log("warn", "upstream_unavailable", { serverId: config.id, code: entry.errorCode });
    } finally {
      entry.lastCheckedAt = new Date().toISOString();
    }
  }

  async close(): Promise<void> {
    this.closed = true;
    await Promise.allSettled(this.pending.values());
    await Promise.all(
      [...this.entries.values()].map(async (entry) => {
        const client = entry.client;
        entry.client = undefined;
        entry.subscription = undefined;
        await client?.close().catch(() => undefined);
        this.tools.remove(entry.config.id);
      }),
    );
  }
}
