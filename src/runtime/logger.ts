export type LogFields = Record<string, string | number | boolean | undefined>;

export function log(level: "info" | "warn" | "error", event: string, fields: LogFields = {}): void {
  process.stderr.write(
    `${JSON.stringify({ timestamp: new Date().toISOString(), level, event, ...fields })}\n`,
  );
}
