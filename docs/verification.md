# MCP Gateway v1 验收记录

验收日期：2026-09-07（Asia/Shanghai）。本记录区分代码与本地集成验证、部署配置校验及尚未完成的外部验收；不把配置校验或测试替身视为生产联调成功。

## 环境与结论

- Windows，Node.js `v24.18.0`，pnpm `11.23.0`，Docker Compose `v5.4.0`。
- 官方 MCP TypeScript SDK `2.0.0`；验证协议为 `2026-07-28` 和 `2025-11-25`。
- v1 的认证、授权、工具/服务注册、路由代理、健康检查、审计及 Dev/Infra/Blog 共 17 个工具已实现，本地全量检查与构建产物冒烟通过。
- Docker Engine 当前不可连接，尚未完成镜像构建、Nginx/容器运行、TLS 握手和真实外部业务 API 验收。
- 本轮未覆盖或输出已有 `.env`、`secrets/`，未执行真实 GitHub 写入、博客发布或 Docker 重启。

## 已执行的验证

以下命令从项目根目录执行。

| 命令 | 本次结果 | 能证明的范围 |
|---|---|---|
| `pnpm format` | 通过，检查 55 个文件、格式化 2 个文件 | 现有 Biome 规则 |
| `pnpm check` | 通过：类型检查、lint、13 个测试文件 / 210 项测试、生产构建 | 源码与本地自动化集成 |
| `pnpm smoke:built` | 通过，8 组协议/角色检查，18 条审计事件 | 编译后 HTTP 模块、官方 SDK 和真实本地 HTTP 链路 |
| `docker compose -f docker-compose.yml config --quiet` | 退出码 0 | 默认部署配置解析 |
| `docker compose -f docker-compose.yml -f deploy/compose.tls.yml config --quiet` | 退出码 0 | TLS 覆盖配置合并 |
| 默认文件与全部五个可选覆盖文件的 `config --quiet` | 使用显式示例配置后退出码 0 | GitHub、Blog、仓库、Docker socket、TLS 配置同时合并 |

测试中的 `audit_write_failed`、`upstream_protocol_error` 和 `upstream_unavailable` 日志来自刻意注入的故障场景；是否通过以 Vitest 汇总和进程退出码为准。

### 构建产物冒烟

`scripts/smoke-built.mjs` 使用临时端口、随机 Token 与临时审计目录，在一个前台进程中运行 Gateway 和三个 HTTP 能力模块。它导入的是 `dist/` 编译产物，不读取个人 `.env`，退出时释放测试资源。

| 角色 | `2026-07-28` 工具数 | `2025-11-25` 工具数 | 只读探针 |
|---|---:|---:|---|
| viewer | 11 | 11 | 两个协议均通过 |
| developer | 15 | 15 | 两个协议均通过 |
| operator | 17 | 17 | 两个协议均通过 |
| admin | 17 | 17 | 两个协议均通过 |

另外验证了：

- 8 次 `server.info` 只读调用成功。
- 两个协议下 viewer 的写操作均被拒绝，不触发真实写入。
- 健康刷新后服务仍正常，工具清单可用。
- 审计共 18 条：8 次成功调用的 start/finish，加上 2 次拒绝；无测试 Token 泄露。

这不是四个独立 CLI 进程的验收，也不经过 Nginx 或容器网络。

### 关键安全与恢复回归

| 边界 | 验证内容 | 测试文件 |
|---|---|---|
| 配置与凭据 | 缺失/重复凭据、ENV/Secret 文件、无效策略、工具命名冲突 | `tests/config.test.ts` |
| 授权与风险 | Bearer、角色、全部必需 Scope、L0–L3、生产操作默认拒绝 | `tests/auth-policy.test.ts` |
| 请求体与方法 | Gateway/能力入口拒绝不支持的方法、非 POST 请求体及超大 POST；CORS 兼容现代 MCP Header | `tests/http-boundaries.test.ts`、`tests/gateway.test.ts` |
| 不重试写调用 | 上游返回 Header Mismatch 时只执行一次，不触发 SDK 隐式刷新后重发；保留错误审计 | `tests/proxy-retries.test.ts` |
| 发现与订阅恢复 | 订阅单独断开后在健康检查恢复；保留在线客户端；恢复后的订阅不被请求超时误杀；停止后不重新订阅 | `tests/gateway-discovery.test.ts` |
| 注册与生命周期 | 未知工具默认不公开、分页清单稳定、上游发现/故障恢复 | `tests/registry.test.ts`、`tests/gateway-discovery.test.ts` |
| 会话与审计 | 跨身份会话拒绝、TTL/配额、认证后错误身份、执行前审计失败阻止操作 | `tests/gateway.test.ts` |
| stdio 隔离 | 真实子进程 MCP 链路、显式环境传递、不自动加载 Gateway 的工作目录 `.env` | `tests/stdio.test.ts` |
| 业务适配 | 临时 Git 仓库、受控命令执行、本地 GitHub/Blog 接口替身、白名单及错误脱敏 | `tests/capability-dev-infra.test.ts`、`tests/capability-blog.test.ts` |

请求边界、Header Mismatch 重试及订阅断线恢复均先用定向回归复现问题，再修复并纳入本次全量测试。

### 定向复审

独立只读复审检查了本轮 HTTP 边界、SDK 隐式重试及订阅恢复相关实现、回归测试与本地已安装的 SDK，未发现已确认的剩余阻断问题。该结论仅覆盖这三项修改，不是全仓库安全审计；复审者没有独立重跑全量测试或访问外部 API，本记录的测试结果来自主验收流程实际执行的命令。

### 可选 Compose 配置校验

所有可选覆盖文件仍要求显式填写必需变量。直接启用 GitHub 覆盖文件而没有 `GITHUB_ALLOWED_REPOSITORIES` 时，Compose 正确拒绝解析，不自动扩大白名单。

本次仅在临时校验进程中设置以下公开示例值，未保存到 `.env`，也未据此启动服务：

```text
GITHUB_ALLOWED_REPOSITORIES=example/repository
BLOG_API_URL=https://blog.example.invalid
INFRA_DOCKER_CONTAINERS=example-container
DOCKER_SOCKET_GID=999
```

合并校验命令：

```powershell
docker compose -f docker-compose.yml -f deploy/compose.github.yml -f deploy/compose.blog.yml -f deploy/compose.repositories.yml -f deploy/compose.docker-socket.yml -f deploy/compose.tls.yml config --quiet
```

示例值不是可用业务配置。此校验不证明 Secret/证书/仓库文件已存在、挂载权限正确、socket GID 正确、Nginx 语法有效或服务能启动。

## 未完成的外部验收

| 项目 | 当前限制 | 接入方后续操作 |
|---|---|---|
| Docker 镜像和容器 | `docker info` 无法连接 `npipe:////./pipe/dockerDesktopLinuxEngine`，提示找不到文件 | 启动 Docker Desktop/Engine，构建镜像并验证容器健康、Secret 读取与审计卷权限 |
| Nginx / TLS | 没有运行中的容器，也未提供真实证书 | 验证 Nginx 配置、HTTPS、Host/Origin 白名单、流式响应和长连接 |
| 独立编译后 CLI / built stdio | 构建冒烟在单个前台进程内；stdio 自动化覆盖源码启动的真实子进程 | 按 README 启动独立编译产物，另验 `config/servers.stdio.yaml` |
| GitHub / Git 拉取 | 未提供真实受限凭据、可信仓库及远端授权 | 先验证白名单内只读操作，再经授权验证测试仓库写操作 |
| Go Blog API | 当前依据文档化 REST 合约与本地替身实现 | 确认真实 DTO/路径/认证，按 `docs/blog-api.md` 对接测试环境 |
| Docker 工具 | 默认无 socket、容器白名单为空 | 确认高权限风险后按运维文档接入，先验证测试容器只读功能 |

容器可用后的只读验收入口：

```powershell
docker compose up --build -d
docker compose ps
$env:MCP_GATEWAY_URL = "http://127.0.0.1:8088/mcp"
pnpm smoke
Remove-Item Env:MCP_GATEWAY_URL
```

不要以真实发布、PR 创建或容器重启代替默认只读冒烟。超时或断连后，先核对外部系统状态，不要盲目重发写操作。

## 版本边界

本次交付限于原架构的 v1。OAuth/OIDC、人工审批、外部策略服务、分布式限流、Redis/共享会话、可观测性平台、多租户、高可用和 Kubernetes 不在本次验收范围。当前结果不构成生产部署已验收的声明。
