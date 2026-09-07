# MCP Gateway v1 部署与运维

## 配置边界

所有示例命令从项目根目录执行。配置相对路径、审计路径及 stdio 子进程默认工作目录均相对当前工作目录。默认配置是 `config/servers.yaml`，可使用 `--config <path>` 或 `GATEWAY_CONFIG` 选择配置。

YAML 支持 `${ENV_NAME}` 和 `${ENV_NAME:-fallback}`。缺失必需变量、未知配置字段、重复身份/Token/公开工具名称以及不合法策略会导致启动失败。`GATEWAY_HOST`、`GATEWAY_PORT`、`GATEWAY_ALLOWED_HOSTS` 和 `GATEWAY_ALLOWED_ORIGINS` 可覆盖相应 YAML 字段。

为上游工具配置 `servers[].tools` 策略后才允许注册。未配置的工具默认不公开；`defaultPolicy` 会授权该上游未来发现的所有工具，仅适用于完全可信且风险一致的上游。默认公开名为 `serverId.originalName`，可用 `publicName` 显式映射；本地能力等级、Scope、超时等覆盖上游声明，不能由上游自行降低风险。

更改本地 YAML 或 Token 后重启 Gateway；v1 不实现配置热加载。工具清单动态变化及恢复后的发现不需要手动重启。分页游标与注册表版本关联，清单变化后客户端应从第一页重新拉取。

## HTTP 与订阅边界

Gateway 和能力服务的 `/mcp` 只接受 POST、GET、DELETE、OPTIONS；其他方法返回 405。GET、DELETE、OPTIONS 必须不带请求体，携带请求体时返回 400 并关闭连接。POST 请求体上限为 1 MiB，同时检查声明长度和实际读取字节，超限返回 413；这些检查发生在 SDK 读取请求体之前。

CORS 预检支持现代协议的 `Mcp-Method`、`Mcp-Name` Header；仍需配置精确 Origin 白名单，不能通过放宽方法/请求体约束解决浏览器接入问题。

现代协议工具变更订阅可以在客户端其他请求仍正常时单独断开。Gateway 在后续健康检查中尝试恢复缺失的订阅，一次健康检查至多尝试一次，不立即无限重连；服务关闭后不再恢复。订阅失败期间仍通过健康检查重新发现工具，订阅恢复后重新支持即时变更通知。

Gateway 向 SDK 传入已发现的工具定义，避免 SDK 在 Header Mismatch 后隐式刷新并重发工具调用。收到工具超时、协议错误或连接错误时，不能据此推断外部操作尚未发生。

## Docker 基线

需要 Docker Engine 与支持 `!override` 的 Docker Compose 2.24.4+（或后续主版本）。镜像构建需要网络下载 Node 基础镜像、Alpine 软件包与 pnpm 依赖。

```powershell
pnpm run setup
docker compose config --quiet
docker compose up --build -d
docker compose ps
docker compose logs --tail 100 gateway
```

`config --quiet` 仅校验配置，不能证明镜像构建、Nginx 语法或容器运行成功。Docker Desktop/Engine 未启动时，请先由运维启动服务再执行容器验收。

默认仅 `127.0.0.1:8088` 暴露 Nginx HTTP 端口。Gateway 与三个能力服务无宿主端口映射；业务服务可以出站访问所配置的 API。Nginx 保留原始 Host 和 Bearer Header，禁用请求/响应缓冲、缓存和失败转发重试，支持长连接流式响应。

所有 Node 容器使用 UID/GID 1000，Nginx 使用 101。容器移除 capabilities，启用 no-new-privileges、只读根文件系统、受限临时目录和 PID 数量。审计目录的初始镜像权限为 0700，文件为 0600。首次创建的命名卷保留 UID 1000 的目录所有权。

若复用已有卷或宿主文件归属不是这些 UID，应明确设置服务账号可读/可写的所有权或 ACL；不要为了方便将 Secret 或审计设置成全员可读写。Compose 基于宿主文件的 Secret 在不同平台上的 UID/mode 行为有差异，部署前必须验证容器实际读取权限。

```powershell
docker compose stop
docker compose down
```

停止或移除容器不会删除审计卷。不要随意执行 `down --volumes`，那会删除持久化审计。服务接受 SIGINT/SIGTERM 并关闭连接；强制终止可能留下仅有 start 的审计记录。

## 外部业务 Secret

基础 Compose 不读取 `.env` 中的业务 Token 到容器，也不默认创建业务 Secret。先由管理员安全创建以下文件，再选择相应覆盖文件：

| 场景 | 单行 Secret 文件 | 必须配置 |
|---|---|---|
| GitHub | `secrets/github_token` | `GITHUB_ALLOWED_REPOSITORIES=owner/repo,...` |
| Blog | `secrets/blog_api_token` | `BLOG_API_URL`，默认要求 Bearer 认证 |

```powershell
docker compose -f docker-compose.yml -f deploy/compose.github.yml up --build -d
docker compose -f docker-compose.yml -f deploy/compose.blog.yml up --build -d
```

多个覆盖文件可以一起使用，之后的 `config/up/stop/down` 应继续使用同一组 `-f` 参数。同名 ENV 与 `_FILE` 同时有值会被拒绝。Secret 不放入源码、镜像、命令行参数或日志。

轮换 Gateway Token 时同步对应 `.env` / `secrets/` 文件并重启 Gateway，再更新客户端；v1 不提供旧/新 Token 双窗口轮换。泄露上游 Token 后应重启 Gateway 与所有相关能力服务并替换凭据。

## Git 仓库挂载

`deploy/compose.repositories.yml` 是需要编辑的示例，将宿主 `/srv/mcp-repositories/example` 只读挂载到 Dev MCP 的 `/workspaces/example`，公开别名 `example`。不要直接使用不存在的示例路径；`create_host_path: false` 可避免误创建空目录掩盖配置错误。

只读挂载适用于 status/log；要允许 `git.pull`，必须明确改为可写并验证 UID 1000 的仓库权限。Git 不允许未知仓库别名或调用者选择远端/任意命令，pull 仅 fast-forward，禁用 hooks/fsmonitor，禁止交互凭据提示，且不自动重试。

Git 的远端、服务账号凭据和 safe.directory 应由管理员预配置。不要为不可信仓库设置 `safe.directory=*`，也不要挂载个人整个 HOME/SSH 目录或高权限凭据。GitHub API Token 不会自动用于本地 Git 拉取；两者是不同的凭据通道。

## Docker socket：显式高权限选择

默认 Docker 工具因白名单为空而拒绝执行，且 Infra MCP 没有 Docker socket。只有确实需要管理容器时才考虑 `deploy/compose.docker-socket.yml`。

该覆盖文件需要 `INFRA_DOCKER_CONTAINERS` 精确白名单和宿主 socket 的 `DOCKER_SOCKET_GID`，并将 socket 组加入非 root 服务账号。Linux 下可由管理员用 `stat -c %g /var/run/docker.sock` 确认实际 GID；Docker Desktop 需根据其 Linux Engine 环境单独确认。

**即使挂载标记为只读，Docker socket 仍能通过 API 执行写操作；它通常等同于宿主机 root 权限。** 工具白名单不是 Docker 守护进程的安全隔离。更安全的生产方案是受限 socket 代理、专用 Docker daemon 或独立运维主机；不要把 socket 当作普通只读文件授权。

```powershell
docker compose -f docker-compose.yml -f deploy/compose.docker-socket.yml config --quiet
docker compose -f docker-compose.yml -f deploy/compose.docker-socket.yml up --build -d
```

只对白名单内的测试容器验证日志读取。容器重启是真实敏感操作，不属于默认冒烟流程。

## TLS 与远程接入

准备有效证书 `deploy/certs/fullchain.pem` 和私钥 `deploy/certs/privkey.pem`。目录被忽略，文件不会复制进镜像。私钥必须能被 Nginx UID 101 读取但不能全员可读；在 Linux 上可用专用组或受限 ACL 配置。

设置 `GATEWAY_PUBLIC_HOST` 为证书对应的域名，例如 `mcp.example.com`，并按需要配置 `GATEWAY_ALLOWED_HOSTS`。这里只填 hostname，不包含 scheme、路径或端口。浏览器调用还需显式设置 `GATEWAY_ALLOWED_ORIGINS=https://client.example.com`；默认空列表拒绝所有携带 Origin 的请求，不使用通配符。

```powershell
docker compose -f docker-compose.yml -f deploy/compose.tls.yml config --quiet
docker compose -f docker-compose.yml -f deploy/compose.tls.yml up --build -d
```

TLS 覆盖文件使用 `!override` 移除 HTTP 宿主端口，仅绑定 `127.0.0.1:8443`；HTTP 8080 只留在容器内部用于存活检查。TLS 1.2/1.3、流式代理和证书挂载见 `deploy/nginx/tls.conf`。

默认仍不向公网暴露。若确需远程访问，审核防火墙、证书、Host/Origin 白名单、最小权限 Token 和访问日志后，显式修改宿主绑定/端口或接入现有 HTTPS 入口。不要把带 Bearer 的明文开发端口直接公开。

Nginx 的日志只记录方法、路径、状态、流量与耗时，不记录 Authorization、请求正文或 query。IP 地址与路径仍可能敏感，应制定访问权限和保留期限。

## 故障排查

| 症状 | 检查项 |
|---|---|
| HTTP 401 / `AUTHENTICATION_FAILED` | 使用 Gateway 身份 Token，而不是上游 Token；Header 格式和最少 32 字节要求 |
| HTTP 403 / Host、Origin 被拒绝 | hostname 和完整 Origin 是否显式配置；不要改为通配符 |
| `AUTHORIZATION_DENIED` | 角色风险上限、全部 requiredScopes、仓库或容器白名单 |
| `POLICY_DENIED` | L3 默认关闭；Docker 容器是否配置 |
| `TOOL_NOT_FOUND` | 工具是否有本地策略、名称映射是否正确、上游健康/发现是否成功 |
| `INVALID_ARGUMENT` | 参数类型/额外字段、分页游标、Content-Type 和 1 MiB 请求限制 |
| `MCP_SERVER_UNAVAILABLE` | 上游地址/独立 Token、可执行文件、业务 API 配置、网络可达性 |
| `TOOL_EXECUTION_FAILED` | 上游业务失败已脱敏；在业务服务侧按时间/requestId 排查，避免把凭据打印到日志 |
| `TIMEOUT` | 操作可能已执行；先查真实状态，不自动重试写操作 |
| `AUDIT_UNAVAILABLE` | 审计卷权限、剩余空间、目录/文件是否可写；执行前失败会阻止操作 |
| `INVALID_SESSION` | 旧协议会话过期、服务重启或跨身份复用；重新 initialize |
| HTTP 429 / `RATE_LIMITED` | 旧协议会话总数/单身份配额耗尽；关闭闲置会话或等待 TTL |

基础工具审计写入 JSONL，每次成功调用有 start/finish；拒绝、参数失败等可能只有 finish。使用 requestId 关联记录，不通过相邻行猜测请求。HTTP 认证前拒绝记录为 anonymous，认证后的解析/会话错误保留已认证身份。

审计文件不是防篡改账本，v1 不提供自动归档、远程审计仓库或事务性 exactly-once。请监控存储容量、限制文件权限并在外部配置轮转和备份。单进程 JSONL 与内存会话也不等于分布式审计/会话架构。
