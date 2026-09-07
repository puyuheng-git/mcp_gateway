import { config as loadEnv } from "dotenv";
import { installShutdown } from "./capabilities/runtime.js";
import { loadConfig } from "./config/config.js";
import { log } from "./runtime/logger.js";
import { createGateway } from "./server/gateway.js";

async function main(): Promise<void> {
  loadEnv({ quiet: true });
  const configIndex = process.argv.indexOf("--config");
  const configPath = configIndex >= 0 ? process.argv[configIndex + 1] : process.env.GATEWAY_CONFIG;
  if (configIndex >= 0 && !configPath) throw new Error("--config requires a YAML file path");
  const configuration = loadConfig(configPath);
  const gateway = await createGateway(configuration);
  await gateway.listen();
  installShutdown(() => gateway.close());
  log("info", "gateway_listening", {
    host: configuration.gateway.host,
    port: configuration.gateway.port,
    status: gateway.health.snapshot().status,
  });
}

main().catch((error: unknown) => {
  log("error", "gateway_start_failed", {
    message: error instanceof Error ? error.message : "Startup failed",
  });
  process.exitCode = 1;
});
