# MCP Gateway v1

根据 [技术架构设计 v1.0](MCP_Gateway_技术架构设计_v1.0.md) 实现的统一 MCP 入口。Gateway 负责认证、RBAC、工具发现与路由、代理、健康检查和审计；Dev、Infra、Blog 三个独立能力服务负责实际操作。

技术栈：Node.js 24、TypeScript、官方 MCP TypeScript SDK 2.0.0、Zod、Ajv、YAML、Vitest、Biome。支持 MCP `2026-07-28` Streamable HTTP、旧版 `2025` Streamable HTTP 会话，以及本地 stdio 上游。没有实现旧式独立 `/sse` 入口。

## 快速开始

需要 Node.js 24+ 和 pnpm 11.23.0。Git 能力需要 Git；Docker 能力需要可访问的 Docker Engine。仅运行网关、系统只读工具和测试，不需要 GitHub 或博客凭据。

在项目根目录执行：

```powershell
pnpm install --frozen-lockfile
pnpm run setup
pnpm build
```

`pnpm run setup` 首次创建 `.env`，生成四个独立的 Gateway Token 和一个独立的上游 Token，并生成 `secrets/` 下的 Docker Secret 文件。不会打印 Token、覆盖已有 `.env` 或静默覆盖不一致的 Secret。`.env`、`secrets/` 和审计日志均已排除在版本管理与镜像构建上下文之外。这里必须保留 `run`：`pnpm setup` 是 pnpm 自身的安装配置命令，不是项目初始化脚本。

分别在四个终端、同一项目根目录运行：

| 进程 | 命令 | 默认监听 |
|---|---|---|
| Dev MCP | `node dist/capabilities/dev/main.js` | `127.0.0.1:3001` |
| Blog MCP | `node dist/capabilities/blog/main.js` | `127.0.0.1:3002` |
| Infra MCP | `node dist/capabilities/infra/main.js` | `127.0.0.1:3003` |
| Gateway | `pnpm start` | `127.0.0.1:3000` |

然后在另一个终端执行只读冒烟检查：

```powershell
pnpm smoke
```

默认使用 viewer Token，列出当前授权的工具并调用 `server.info`。完整配置下 viewer 可发现 11 个只读工具；operator/admin 可发现全部 17 个工具。工具可以被发现不代表外部业务系统已配置：未配置的仓库、容器、GitHub 或博客调用会安全失败。

开发模式使用 `pnpm dev`、`pnpm mcp:dev`、`pnpm mcp:blog`、`pnpm mcp:infra`。每个进程仍需独立终端；以 `Ctrl+C` 退出。

## 接入客户端

- Endpoint：`http://127.0.0.1:3000/mcp`。
- 每个请求携带 `Authorization: Bearer <token>`，优先使用 `.env` 中的 `GATEWAY_VIEWER_TOKEN`，按需要换用更高权限身份。
- 客户端只连接 Gateway，不直接连接能力服务，也不使用 `MCP_UPSTREAM_TOKEN`。
- 远程接入必须使用 HTTPS；默认监听仅适合本机开发。不同 MCP 客户端的配置格式可能不同，以下仅演示 URL 和 Header：

```json
{
  "mcpServers": {
    "gateway": {
      "url": "http://127.0.0.1:3000/mcp",
      "headers": {
        "Authorization": "Bearer <GATEWAY_VIEWER_TOKEN>"
      }
    }
  }
}
```

占位符不会自动展开；请使用客户端自己的 Secret/环境变量机制，不要提交真实 Token。可参考 `scripts/smoke.ts` 使用官方 SDK 接入。

## 工具与权限

公开名称采用点分命名。所有参数对象拒绝未知字段；`?` 表示可省略。精确约束以 `tools/list` 返回的 `inputSchema` 为准。

| 工具 | 主要参数 | 风险 | Scope |
|---|---|---|---|
| `git.status` | `repository`，配置中的仓库别名 | L0 | `git:read` |
| `git.log` | `repository`, `limit?=10`，上限 100 | L0 | `git:read` |
| `git.pull` | `repository`；只允许 fast-forward，不运行 hooks | L1 | `git:write` |
| `github.issue.list` | `repository=owner/repo`, `state?=open`, `limit?=20`, `page?=1` | L0 | `github:read` |
| `github.pr.list` | 同上 | L0 | `github:read` |
| `github.pr.create` | `repository`, `title`, `head`, `base`, `body?`, `draft?=false` | L1 | `github:write` |
| `server.info` | `{}` | L0 | `server:read` |
| `server.disk` | `{}`；仅管理员配置的磁盘路径 | L0 | `server:read` |
| `server.memory` | `{}` | L0 | `server:read` |
| `docker.ps` | `{}`；只返回白名单容器 | L0 | `docker:read` |
| `docker.logs` | `container`, `tail?=100`，上限 1000 | L0 | `docker:read` |
| `docker.restart` | `container`；固定 10 秒停止等待 | L2 | `docker:write` |
| `blog.search` | `q?=""`, `page?=1`, `pageSize?=20`，上限 100 | L0 | `blog:read` |
| `blog.get` | `id` | L0 | `blog:read` |
| `blog.create` | `title`, `content`, `slug?`, `tags?` | L1 | `blog:write` |
| `blog.update` | `id`，以及至少一个 `title/content/slug/tags` | L1 | `blog:write` |
| `blog.publish` | `id` | L2 | `blog:write` |

角色必须同时满足风险上限和全部 requiredScopes：

| 角色 | 风险上限 | 默认权限 |
|---|---|---|
| viewer | L0 | 所有已定义领域的只读 Scope |
| developer | L1 | viewer + Git、GitHub、Blog 写入 |
| operator | L2 | developer + Docker 写入，可发布博客 |
| admin | L3 | 全部 Scope；仍受生产策略限制 |

`policy.allowProduction` 默认 `false`，admin 也不能执行 L3。v1 不提供生产部署工具或审批流程，不应仅为绕过策略开启此开关。

## 配置能力服务

编辑 `.env` 后重启相关进程。HTTP 能力服务从 `.env` 读取配置；Gateway 从 `config/servers.yaml` 加载注册表与本地工具策略。

| 变量 | 用途 |
|---|---|
| `DEV_REPOSITORIES` | JSON 别名到可信 Git 工作目录的映射，例如 `{"blog":"D:/projects/blog"}`；默认 `{}` |
| `GITHUB_TOKEN` / `GITHUB_TOKEN_FILE` | 独立的最小权限 GitHub 凭据 |
| `GITHUB_ALLOWED_REPOSITORIES` | 逗号分隔的 `owner/repo` 白名单；默认空 |
| `GITHUB_API_URL` | 可选 GitHub Enterprise API 根地址；默认 GitHub 官方 API |
| `INFRA_DOCKER_CONTAINERS` | 逗号分隔的精确容器名称；默认空，不接受通配符或 ID 前缀 |
| `INFRA_DISK_PATH` | `server.disk` 检查的固定路径；默认当前目录 |
| `BLOG_API_URL` | 现有 Go 博客 HTTP API 根地址 |
| `BLOG_API_TOKEN` / `BLOG_API_TOKEN_FILE` | 独立的博客 API Bearer Token |
| `BLOG_ARTICLES_PATH` | 文章集合路径，默认 `/api/articles` |
| `BLOG_REQUIRE_AUTH` | 默认 `true`；仅明确无认证的测试 API 可设 `false` |

Git 远端、分支、凭据与工作目录由运维预配置，工具不能指定任意命令、路径或远端。只为可信仓库开放写权限。容器中的系统信息来自该进程看到的 OS/文件系统，不等同于宿主机的完整监控或容器配额指标。

博客只通过 HTTP API 操作业务系统，不连接 MySQL。[博客接口约定](docs/blog-api.md) 说明 DTO、路径映射和适配点；真实 Go API 合约及凭据尚需接入方确认。

## 本地 stdio 上游

只启动 Gateway，由它管理本地 Infra 子进程：

```powershell
pnpm build
node dist/main.js --config config/servers.stdio.yaml
```

该示例只公开三个系统只读工具，不需要独立 Infra HTTP 服务。仍通过 Gateway `/mcp` 使用 Bearer 认证。也可为任意能力入口传 `--stdio`，用于受信任的本地 MCP 宿主。

stdio 子进程只获得 SDK 的基础环境和 YAML `servers[].env` 显式配置，不继承 Gateway Token，也不自动读取当前目录 `.env`。需要传入上游业务凭据时，在配置中显式指定 ENV/`_FILE`，只传所需项。stdio 不是 OS 沙箱，应使用受信任的命令、独立服务账号和最小文件权限。

## Docker Compose

```powershell
pnpm run setup
docker compose config --quiet
docker compose up --build -d
docker compose ps
```

仅 Nginx 暴露 `127.0.0.1:8088`，入口为 `http://127.0.0.1:8088/mcp`。其余四个服务只在 Docker 网络中通信。进程非 root、根文件系统只读，审计持久化到 `gateway_audit` 卷。

通过 Nginx 执行只读冒烟：

```powershell
$env:MCP_GATEWAY_URL = "http://127.0.0.1:8088/mcp"
pnpm smoke
Remove-Item Env:MCP_GATEWAY_URL
```

默认不挂载 Docker socket 或任何 Git 仓库，也不把宿主 `.env` 整体注入容器。GitHub/博客业务 Secret、仓库、Docker socket 与 TLS 均需选择独立覆盖文件，详见 [部署与运维](docs/operations.md)。

## 健康、审计与错误

- `GET /health/live`：进程存活，无须 Token。
- `GET /health/ready`：所有启用且 `required: true` 的上游 MCP 健康时返回 200，否则 503；可选上游故障返回 `degraded`。
- `GET /health`：需要 Bearer 和 `server:read`；包含各上游状态、工具数与旧协议会话数，不包含配置密钥。
- 上游健康表示 MCP 协议连通和发现成功，不保证 GitHub、Docker、博客业务 API 已授权或可用。健康循环默认 30 秒，支持重连与重新发现；新协议工具变更订阅可触发即时刷新，订阅单独断开后由下一次健康检查尝试恢复。
- 审计默认写入 `var/audit/gateway.jsonl`，记录 requestId、身份/角色、工具、上游、风险、结果状态及耗时，不记录参数、返回值、Token 或上游错误正文。工具名与身份元数据仍可能敏感，应限制读取权限。
- 执行前审计写入失败会阻止操作。执行后若超时、断连或审计失败，操作可能已经发生；不要盲目重试写操作。Gateway 和能力适配器均不自动重试工具调用。
- 工具错误使用 MCP `isError`，附统一 `code/message/requestId/tool/retryable`；HTTP 认证/传输错误使用 HTTP 状态和 JSON-RPC error。常见代码见运维文档。

## 开发与验收

```powershell
pnpm check
```

依次执行类型检查、Biome、Vitest 和生产构建。测试使用真实 HTTP/stdio MCP 链路、临时 Git 仓库、本地 REST API 和受控命令替身，不会创建真实 GitHub PR、发布真实文章或重启真实 Docker 容器。

```powershell
pnpm smoke:built
```

此命令构建后，在单个前台进程中以临时端口启动 Gateway 和三个 HTTP 能力模块，验证新旧协议下四个角色的工具清单、只读调用、越权阻止、健康刷新和审计。使用临时随机 Token 和临时审计目录，不读取个人 `.env`，退出时释放监听与临时文件；它不是后台服务启动命令，也不替代 Docker/独立进程部署验收。

`pnpm format` 应用仓库现有 Biome 规则。设计决策与实施清单位于 `docs/superpowers/`。本机验收结果和未验证的外部依赖记录于 [v1 验收记录](docs/verification.md)。

## v1 边界

已实现统一 tools 入口、基础 Bearer/RBAC、显式本地策略、工具/服务注册、HTTP/stdio 代理、基础健康与审计、Dev/Infra/Blog 能力及 Compose 部署。

不实现 resources/prompts 聚合、OAuth/OIDC、ABAC/外部策略服务、人工审批、全局限流、熔断/自动重试、Redis、分布式会话、高可用、多租户、Prometheus/OpenTelemetry 或 Kubernetes。旧协议会话与新协议订阅均为进程内状态；不应直接以多副本部署宣称支持无状态故障切换。
