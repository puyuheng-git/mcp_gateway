import { z } from "zod";
import { csv } from "../../config/config.js";
import { readOptionalSecret } from "../../config/secrets.js";
import { log } from "../../runtime/logger.js";
import { loadCapabilityEnvironment, runCapability } from "../runtime.js";
import { createDevTools } from "./tools.js";

async function main(): Promise<void> {
  loadCapabilityEnvironment();
  const repositories = z
    .record(z.string().regex(/^[A-Za-z0-9_.-]{1,64}$/), z.string().min(1))
    .parse(JSON.parse(process.env.DEV_REPOSITORIES ?? "{}") as unknown);
  await runCapability(
    "dev-mcp",
    3001,
    createDevTools({
      repositories,
      githubToken: readOptionalSecret("GITHUB_TOKEN"),
      githubAllowedRepositories: csv(process.env.GITHUB_ALLOWED_REPOSITORIES),
      githubApiUrl: process.env.GITHUB_API_URL,
    }),
  );
}

main().catch(() => {
  log("error", "dev_start_failed", {
    message: "Check Dev MCP configuration and secret references",
  });
  process.exitCode = 1;
});
