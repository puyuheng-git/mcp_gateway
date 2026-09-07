import { readFileSync } from "node:fs";

export type Environment = Record<string, string | undefined>;

export function readSecret(name: string, env: Environment = process.env): string {
  const direct = env[name];
  const file = env[`${name}_FILE`];
  if (direct && file) throw new Error(`Set only ${name} or ${name}_FILE, not both`);
  let value = direct;
  if (file) {
    try {
      value = readFileSync(file, "utf8").trim();
    } catch {
      throw new Error(`Cannot read the secret file for ${name}`);
    }
  }
  if (!value || value.trim() !== value || /[\r\n]/.test(value)) {
    throw new Error(`A nonempty, single-line secret is required for ${name}`);
  }
  return value;
}

export function readOptionalSecret(
  name: string,
  env: Environment = process.env,
): string | undefined {
  return env[name] || env[`${name}_FILE`] ? readSecret(name, env) : undefined;
}
