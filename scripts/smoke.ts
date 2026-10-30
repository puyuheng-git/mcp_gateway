import { Client, StreamableHTTPClientTransport } from "@modelcontextprotocol/client";
import { config as loadEnv } from "dotenv";
import { readSecret } from "../src/config/secrets.js";

async function smoke(): Promise<void> {
  loadEnv({ quiet: true });
  const endpoint = process.env.MCP_GATEWAY_URL ?? "http://127.0.0.1:3000/mcp";
  const token = readSecret(process.env.SMOKE_TOKEN_ENV ?? "GATEWAY_VIEWER_TOKEN");
  const client = new Client(
    { name: "gateway-smoke", version: "1.0.0" },
    { versionNegotiation: { mode: { pin: "2026-07-28" } } },
  );
  try {
    await client.connect(
      new StreamableHTTPClientTransport(new URL(endpoint), {
        requestInit: { headers: { Authorization: `Bearer ${token}` } },
      }),
    );
    const { tools } = await client.listTools();
    if (!tools.some((tool) => tool.name === "server_info"))
      throw new Error("server_info was not discovered");
    const result = await client.callTool({ name: "server_info", arguments: {} });
    if (result.isError) throw new Error("Read-only smoke tool failed");
    console.log(
      JSON.stringify(
        {
          status: "ok",
          protocol: "2026-07-28",
          endpoint,
          discoveredTools: tools.map((tool) => tool.name),
          checkedTool: "server_info",
        },
        null,
        2,
      ),
    );
  } finally {
    await client.close();
  }
}

smoke().catch(() => {
  console.error("Gateway smoke test failed. Check services, configuration and credentials.");
  process.exitCode = 1;
});
