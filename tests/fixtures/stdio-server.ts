import { serveStdio } from "@modelcontextprotocol/server/stdio";
import { z } from "zod";
import {
  createCapabilityMcpServer,
  loadCapabilityEnvironment,
} from "../../src/capabilities/runtime.js";
import { defineTool } from "../../src/capabilities/types.js";

if (process.env.CAPABILITY_TEST_CWD) process.chdir(process.env.CAPABILITY_TEST_CWD);
loadCapabilityEnvironment();

serveStdio(() =>
  createCapabilityMcpServer("stdio-fixture", [
    defineTool({
      name: "inspect_environment",
      description: "Inspect test environment forwarding",
      inputSchema: z.object({}).strict(),
      capabilityLevel: "L0",
      requiredScopes: ["server:read"],
      execute: async () => ({
        secretLeaked: Boolean(process.env.PRIVATE_GATEWAY_TEST_TOKEN),
        forwarded: process.env.EXPLICIT_STDIO_VALUE,
      }),
    }),
  ]),
);
