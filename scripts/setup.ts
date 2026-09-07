import { randomBytes } from "node:crypto";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { parse } from "dotenv";

const secretNames = [
  "GATEWAY_ADMIN_TOKEN",
  "GATEWAY_VIEWER_TOKEN",
  "GATEWAY_DEVELOPER_TOKEN",
  "GATEWAY_OPERATOR_TOKEN",
  "MCP_UPSTREAM_TOKEN",
];

async function readIfPresent(path: string): Promise<string | undefined> {
  try {
    return await readFile(path, "utf8");
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return undefined;
    throw error;
  }
}

export async function setupEnvironment(directory: string) {
  const envPath = join(directory, ".env");
  let text = await readIfPresent(envPath);
  const createdEnv = text === undefined;
  if (text === undefined) {
    text = await readFile(join(directory, ".env.example"), "utf8");
    for (const name of secretNames)
      text = text.replace(
        new RegExp(`^${name}=$`, "m"),
        `${name}=${randomBytes(32).toString("base64url")}`,
      );
    await writeFile(envPath, text, { flag: "wx", mode: 0o600 });
  }
  const values = parse(text);
  await mkdir(join(directory, "secrets"), { recursive: true, mode: 0o700 });
  const createdSecrets: string[] = [];
  for (const name of secretNames) {
    const value = values[name];
    if (!value || Buffer.byteLength(value) < 32 || /\s/.test(value))
      throw new Error(`Fill ${name} in .env with a token of at least 32 bytes`);
    const filename = name.toLowerCase();
    const path = join(directory, "secrets", filename);
    const existing = await readIfPresent(path);
    if (existing !== undefined) {
      if (existing.trim() !== value)
        throw new Error(`Secret file ${filename} differs from .env; synchronize it explicitly`);
      continue;
    }
    await writeFile(path, `${value}\n`, { flag: "wx", mode: 0o600 });
    createdSecrets.push(filename);
  }
  return { createdEnv, createdSecrets };
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  setupEnvironment(resolve(import.meta.dirname, ".."))
    .then((result) => {
      console.log(
        result.createdEnv
          ? "Created .env with unique random tokens."
          : "Kept existing .env unchanged.",
      );
      console.log(
        `Created ${result.createdSecrets.length} Docker secret files. No token values are printed.`,
      );
      console.log(
        "Configure repositories, container allowlists and the Blog API before using those tools.",
      );
    })
    .catch((error: unknown) => {
      console.error(error instanceof Error ? error.message : "Setup failed");
      process.exitCode = 1;
    });
}
