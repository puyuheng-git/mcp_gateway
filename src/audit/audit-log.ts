import { appendFile, mkdir, open } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import type { CapabilityLevel, Role } from "../auth/identity.js";
import { type ErrorCode, GatewayError } from "../errors.js";

export interface AuditEvent {
  phase: "start" | "finish";
  status: "started" | "success" | "denied" | "error";
  requestId: string;
  identity: string;
  roles?: Role[];
  tool?: string;
  serverId?: string;
  capabilityLevel?: CapabilityLevel;
  durationMs?: number;
  errorCode?: ErrorCode;
}

export interface AuditWriter {
  write(event: AuditEvent): Promise<void>;
}

export class JsonlAuditLog implements AuditWriter {
  private pending: Promise<void> = Promise.resolve();
  private initialized = false;
  readonly path: string;

  constructor(path: string) {
    this.path = resolve(path);
  }

  async initialize(): Promise<void> {
    await mkdir(dirname(this.path), { recursive: true, mode: 0o700 });
    const file = await open(this.path, "a", 0o600);
    await file.close();
    this.initialized = true;
  }

  async write(event: AuditEvent): Promise<void> {
    if (!this.initialized)
      throw new GatewayError("AUDIT_UNAVAILABLE", "Audit storage is unavailable", 503);
    const line = `${JSON.stringify({ timestamp: new Date().toISOString(), ...event })}\n`;
    const operation = this.pending.then(() =>
      appendFile(this.path, line, { encoding: "utf8", mode: 0o600 }),
    );
    this.pending = operation.catch(() => undefined);
    try {
      await operation;
    } catch {
      throw new GatewayError("AUDIT_UNAVAILABLE", "Audit storage is unavailable", 503);
    }
  }

  async close(): Promise<void> {
    await this.pending;
    this.initialized = false;
  }
}
