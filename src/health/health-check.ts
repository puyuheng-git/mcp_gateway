import type { ServerRegistry } from "../registry/server-registry.js";

export class HealthCheck {
  private timer?: NodeJS.Timeout;
  private readonly started = Date.now();

  constructor(
    private readonly registry: ServerRegistry,
    private readonly intervalMs: number,
  ) {}

  start(): void {
    this.timer = setInterval(() => {
      void this.check();
    }, this.intervalMs);
    this.timer.unref();
  }

  async check(): Promise<void> {
    await this.registry.check();
  }

  snapshot() {
    const servers = this.registry.status();
    const enabled = servers.filter((server) => server.enabled);
    const ready =
      enabled.length > 0 &&
      enabled.filter((server) => server.required).every((server) => server.status === "healthy");
    const healthy = enabled.every((server) => server.status === "healthy");
    return {
      status: !ready ? "unavailable" : healthy ? "ok" : "degraded",
      ready,
      uptimeSeconds: Math.floor((Date.now() - this.started) / 1000),
      servers,
    };
  }

  stop(): void {
    if (this.timer) clearInterval(this.timer);
  }
}
