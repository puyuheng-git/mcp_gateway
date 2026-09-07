import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { parse } from "dotenv";
import { expect, it } from "vitest";
import { setupEnvironment } from "../scripts/setup.js";

it("generates unique secrets without replacing existing credentials", async () => {
  const directory = await mkdtemp(join(tmpdir(), "gateway-setup-"));
  try {
    await writeFile(
      join(directory, ".env.example"),
      "GATEWAY_ADMIN_TOKEN=\nGATEWAY_VIEWER_TOKEN=\nGATEWAY_DEVELOPER_TOKEN=\nGATEWAY_OPERATOR_TOKEN=\nMCP_UPSTREAM_TOKEN=\nCUSTOM_SETTING=keep\n",
    );
    expect((await setupEnvironment(directory)).createdEnv).toBe(true);
    const first = await readFile(join(directory, ".env"), "utf8");
    const tokens = Object.entries(parse(first))
      .filter(([name]) => name.endsWith("TOKEN"))
      .map(([, value]) => value);
    expect(tokens).toHaveLength(5);
    expect(new Set(tokens).size).toBe(5);
    expect(tokens.every((value) => value.length >= 32)).toBe(true);
    expect((await setupEnvironment(directory)).createdEnv).toBe(false);
    expect(await readFile(join(directory, ".env"), "utf8")).toBe(first);
    expect((await readFile(join(directory, "secrets", "gateway_admin_token"), "utf8")).trim()).toBe(
      parse(first).GATEWAY_ADMIN_TOKEN,
    );
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});
