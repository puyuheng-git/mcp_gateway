import { randomUUID } from "node:crypto";
import { NodeStreamableHTTPServerTransport } from "@modelcontextprotocol/node";
import type { Server } from "@modelcontextprotocol/server";
import type { Identity } from "../auth/identity.js";
import type { GatewayConfig } from "../config/config.js";
import { GatewayError } from "../errors.js";

export interface Session {
  id: string;
  owner: string;
  lastUsed: number;
  server: Server;
  transport: NodeStreamableHTTPServerTransport;
}

export class SessionManager {
  private readonly sessions = new Map<string, Session>();
  private readonly timer: NodeJS.Timeout;

  constructor(
    private readonly config: Pick<
      GatewayConfig["gateway"],
      "sessionTtlMs" | "maxSessions" | "maxSessionsPerIdentity"
    >,
  ) {
    this.timer = setInterval(
      () => {
        void this.sweep();
      },
      Math.max(100, Math.min(config.sessionTtlMs / 2, 10_000)),
    );
    this.timer.unref();
  }

  get size(): number {
    return this.sessions.size;
  }

  async create(identity: Identity, factory: (identity: Identity) => Server): Promise<Session> {
    const owned = [...this.sessions.values()].filter(
      (session) => session.owner === identity.credentialId,
    ).length;
    if (
      this.sessions.size >= this.config.maxSessions ||
      owned >= this.config.maxSessionsPerIdentity
    ) {
      throw new GatewayError("RATE_LIMITED", "Session capacity reached", 429, true);
    }
    const id = randomUUID();
    const server = factory(identity);
    const transport = new NodeStreamableHTTPServerTransport({
      sessionIdGenerator: () => id,
      enableJsonResponse: true,
      onsessionclosed: () => {
        this.sessions.delete(id);
      },
    });
    const session: Session = {
      id,
      server,
      transport,
      owner: identity.credentialId,
      lastUsed: Date.now(),
    };
    this.sessions.set(id, session);
    try {
      await server.connect(transport);
      const onclose = transport.onclose;
      transport.onclose = () => {
        this.sessions.delete(id);
        onclose?.();
      };
      return session;
    } catch (error) {
      this.sessions.delete(id);
      await server.close().catch(() => undefined);
      throw error;
    }
  }

  get(id: string, identity: Identity): Session {
    const session = this.sessions.get(id);
    if (
      !session ||
      session.owner !== identity.credentialId ||
      Date.now() - session.lastUsed >= this.config.sessionTtlMs
    ) {
      throw new GatewayError("INVALID_SESSION", "Unknown or expired MCP session", 404);
    }
    session.lastUsed = Date.now();
    return session;
  }

  async remove(id: string): Promise<void> {
    const session = this.sessions.get(id);
    this.sessions.delete(id);
    await session?.server.close().catch(() => undefined);
  }

  async notifyToolsChanged(): Promise<void> {
    await Promise.all(
      [...this.sessions.values()].map((session) =>
        session.server.sendToolListChanged().catch(() => undefined),
      ),
    );
  }

  async sweep(): Promise<void> {
    await Promise.all(
      [...this.sessions.values()]
        .filter((session) => Date.now() - session.lastUsed >= this.config.sessionTtlMs)
        .map((session) => this.remove(session.id)),
    );
  }

  async close(): Promise<void> {
    clearInterval(this.timer);
    await Promise.all([...this.sessions.keys()].map((id) => this.remove(id)));
  }
}
