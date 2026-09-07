import { csv } from "../../config/config.js";
import { log } from "../../runtime/logger.js";
import { loadCapabilityEnvironment, runCapability } from "../runtime.js";
import { createInfraTools } from "./tools.js";

async function main(): Promise<void> {
  loadCapabilityEnvironment();
  await runCapability(
    "infra-mcp",
    3003,
    createInfraTools({
      allowedContainers: csv(process.env.INFRA_DOCKER_CONTAINERS),
      diskPath: process.env.INFRA_DISK_PATH ?? ".",
    }),
  );
}

main().catch(() => {
  log("error", "infra_start_failed", {
    message: "Check Infra MCP configuration and secret references",
  });
  process.exitCode = 1;
});
