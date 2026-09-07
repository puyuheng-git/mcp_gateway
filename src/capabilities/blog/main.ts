import { z } from "zod";
import { readOptionalSecret } from "../../config/secrets.js";
import { log } from "../../runtime/logger.js";
import { loadCapabilityEnvironment, runCapability } from "../runtime.js";
import { createBlogTools } from "./tools.js";

async function main(): Promise<void> {
  loadCapabilityEnvironment();
  const requireAuth =
    z.enum(["true", "false"]).parse(process.env.BLOG_REQUIRE_AUTH ?? "true") === "true";
  await runCapability(
    "blog-mcp",
    3002,
    createBlogTools({
      baseUrl: process.env.BLOG_API_URL || undefined,
      token: readOptionalSecret("BLOG_API_TOKEN"),
      articlesPath: process.env.BLOG_ARTICLES_PATH || undefined,
      requireAuth,
    }),
  );
}

main().catch(() => {
  log("error", "blog_start_failed", {
    message: "Check Blog MCP configuration and secret references",
  });
  process.exitCode = 1;
});
