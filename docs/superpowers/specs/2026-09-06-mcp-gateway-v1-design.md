# MCP Gateway v1 实施设计

本设计落实仓库根目录的《MCP_Gateway_技术架构设计_v1.0.md》，不替换该架构基线。用户已要求按该文档完成 v1，并确认继续实施。

## 范围与技术决策

- Node.js 24、TypeScript、官方 MCP SDK 2.0.0（server/client/core/node 分包）、Zod、YAML、pnpm、Vitest、Biome。
- 单一 `/mcp` 入口，支持 MCP 2026-07-28 的逐请求协议及 2025 协议兼容；HTTP Streamable 为主，支持连接本地 stdio 上游。
- Node 原生 HTTP 是架构基线允许的选项；不引入前端、数据库或自研协议栈。
- 按模块拆分配置、认证、授权、工具注册、上游连接、代理、审计、健康、传输与会话。
- 选择官方 SDK 协议实现而非手写 JSON-RPC；选择显式本地策略而非信任上游提供的风险标签。
- v1 不实现资源/提示词聚合、OAuth、审批工作流、Redis、分布式限流、Circuit Breaker、多租户或 Kubernetes；不对外宣称这些能力。

## 安全与请求流

1. 校验 Host/Origin、请求体上限及 Bearer Token；认证适用于 MCP 的每个请求，Token 不透传给上游。
2. Token 从 ENV 或对应的 `_FILE` Docker Secret 读取，至少 32 字节；只保留散列用于常数时间比较。
3. 固定 viewer/developer/operator/admin 四级角色与 L0/L1/L2/L3 风险上限。所有 requiredScopes 均须满足。
4. 默认隐藏没有本地策略的上游工具；默认阻止 L3，即使 admin 也不例外。开启生产工具须显式修改配置。
5. JSON Schema 校验后写审计开始事件，再路由到指定上游。调用永不自动重试，避免重复写操作。
6. 返回标准化错误，包括 code/message/requestId/tool/retryable。失败结果不泄露上游凭据或堆栈。
7. 审计以 JSONL 写入文件，记录身份、工具、上游、风险、状态、耗时，不记录 Token、参数或结果；审计写入失败则拒绝开始执行。

## 上游与协议

- 启动连接各个启用的 MCP，分页发现工具，保存输入/输出 Schema、路由和本地策略元数据。
- 默认公开名为 `serverId.originalName`；YAML 可为固定工具声明规范点分名称。
- 公开名冲突、无效 Schema、重复发现名称均拒绝注册，禁止后注册者静默覆盖路由。
- 一个服务故障不影响其他服务；健康循环检查和重连，恢复后重新发现工具。上游变更触发工具列表刷新。
- 新协议使用 SDK `createMcpHandler`；旧协议提供有身份绑定、数量上限、TTL 和清理的内存会话。
- 连接只服务于 tools/list 和 tools/call；采样、客户端根目录或人工交互请求不转发给其他身份。

## 能力服务

- Dev：git.status/log/pull 与 github.issue.list/pr.list/pr.create。只允许配置的仓库，不接收任意路径或命令。
- Infra：server.info/disk/memory 与 docker.ps/logs/restart。只允许配置的容器，禁止 shell 工具和任意命令拼接。
- Blog：blog.search/get/create/update/publish，仅调用配置的 HTTP 业务 API，不直连 MySQL。未知真实 Go API 合约通过独立适配层及文档说明，不伪造已完成真实业务联调。
- 三类服务均可用 HTTP 或 stdio 启动；HTTP 使用独立上游 Bearer Token。测试外部写操作只对临时仓库或本地测试 API 进行。

## 部署与验收

- Docker Compose 启动 Nginx、Gateway、Dev、Infra、Blog；默认不挂 Docker socket、不允许任何仓库/容器写操作。
- 生产 TLS 配置独立，密钥不进仓库；进程以非 root 用户运行，审计目录持久化。
- 验收覆盖配置、认证、RBAC、工具策略、代理、真实 MCP HTTP/stdio、旧协议会话隔离、错误与超时、JSONL 审计、故障恢复及适配器行为。
- 完成须有 typecheck/lint/test/build 结果；Docker 与外部服务验证明确区分，缺少凭据不使用假成功替代。
