#!/usr/bin/env bash
set -euo pipefail
cd /www/wwwroot/mcp_gateway
export NODE_ENV=production
# Do not `source .env` here: bash mangles JSON values like DEV_REPOSITORIES.
# Each Node entrypoint loads .env via dotenv.
exec /usr/bin/node "$@"
