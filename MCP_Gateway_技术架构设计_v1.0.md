# MCP Gateway 技术架构设计 v1.0

> 文档版本：v1.0  
> 文档状态：架构基线 / 演进规划  
> 技术方向：TypeScript + Node.js + MCP SDK v2 + Streamable HTTP  
> 目标：构建统一、安全、可扩展的 AI 能力接入与治理 Gateway，并逐步演进为 AI Gateway / Enterprise AI OS 的基础设施层。

---

## 1. 文档目标

本文档定义 MCP Gateway 从 V1 到 V3 的整体技术架构、模块边界、技术选型、安全模型、部署模型以及演进路线。

核心原则：

1. Gateway 负责连接、发现、路由、权限、治理，不承担核心业务逻辑。
2. MCP Server 按能力域拆分，而不是按技术语言拆分。
3. 核心业务继续通过 Go API 提供。
4. AI / RAG / Agent 能力优先使用 Python。
5. MCP Gateway 主体使用 TypeScript。
6. 本地优先 stdio，远程优先 Streamable HTTP。
7. 高风险 Tool 必须具备权限控制，生产操作逐步引入 Human Approval。
8. 所有关键 Tool 调用必须具备可审计能力。
9. V1 先解决“统一接入”，V2 解决“治理与规模化”，V3 解决“平台化与企业级 AI 基础设施”。

---

# 2. 产品定位

MCP Gateway 不是一个“大 MCP Server”。

它定位为：

> AI Client 与企业/个人数字能力之间的统一协议网关和治理层。

逻辑架构：

```text
AI Clients
│
├── Claude
├── Cursor
├── OpenClaw
├── ChatGPT
└── Other Agents
│
▼
MCP Gateway
│
├── Authentication
├── Authorization
├── Tool Registry
├── Tool Router
├── MCP Proxy
├── Policy Engine
├── Session Management
├── Audit
└── Observability
│
▼
MCP Servers / Business APIs / Infrastructure
```

---

# 3. 总体技术架构

```text
                           AI Clients
        ┌────────────────────┼────────────────────┐
        │                    │                    │
     Claude                Cursor             OpenClaw
        │                    │                    │
        └────────────────────┼────────────────────┘
                             │
                     MCP Protocol
                             │
                 Streamable HTTP / HTTPS
                             │
                             ▼
              ┌──────────────────────────┐
              │      MCP Gateway         │
              │                          │
              │ TypeScript / Node.js     │
              │                          │
              │ Authentication           │
              │ Authorization            │
              │ Tool Registry            │
              │ Tool Router              │
              │ MCP Proxy                │
              │ Policy Engine            │
              │ Session Manager          │
              │ Audit                    │
              │ Observability             │
              └─────────────┬────────────┘
                            │
            ┌───────────────┼────────────────┐
            │               │                │
            ▼               ▼                ▼
      ┌──────────┐    ┌──────────┐    ┌──────────┐
      │ Dev MCP  │    │ Blog MCP │    │ AI MCP   │
      └────┬─────┘    └────┬─────┘    └────┬─────┘
           │               │               │
       ┌───┼───┐       ┌───┼───┐       ┌───┼───┐
       ▼   ▼   ▼       ▼   ▼   ▼       ▼   ▼   ▼
     Git GitHub CI/CD  Go API MySQL  Ollama RAG ES

                         ┌──────────────┐
                         │  Infra MCP   │
                         └──────┬───────┘
                                │
                       ┌────────┼────────┐
                       ▼        ▼        ▼
                     Linux    Docker    Nginx
```

---

# 4. 核心架构原则

## 4.1 Gateway 与业务解耦

禁止：

```text
AI
 ↓
MCP Gateway
 ↓
直接操作业务数据库
```

推荐：

```text
AI
 ↓
MCP Gateway
 ↓
Blog MCP
 ↓
Go Blog API
 ↓
MySQL / Redis / MinIO / Elasticsearch
```

Gateway 只负责：

- MCP 协议
- 身份认证
- 权限
- Tool 发现
- Tool 路由
- Tool Proxy
- 策略
- 审计
- 监控

---

## 4.2 MCP Server 按能力域拆分

推荐：

```text
Dev MCP
Infra MCP
Blog MCP
AI MCP
```

而不是：

```text
Python MCP
Go MCP
Node MCP
```

技术语言只是实现细节，能力域才是架构边界。

---

# 5. 技术选型

| 层 | V1 选择 | 演进方向 |
|---|---|---|
| Gateway | TypeScript | TypeScript |
| Runtime | Node.js | Node.js |
| MCP SDK | 官方 MCP TypeScript SDK v2 | 跟随官方稳定版本 |
| Schema | Zod | Zod / Standard Schema |
| HTTP | Hono / Node HTTP | Hono |
| Transport | Streamable HTTP | Streamable HTTP |
| Local Transport | stdio | stdio |
| Package Manager | pnpm | pnpm |
| Test | Vitest | Vitest |
| Lint | ESLint / Biome | Biome 或 ESLint |
| Container | Docker | Kubernetes（V3 可选） |
| Proxy | Nginx | Nginx / Gateway LB |
| Cache | Redis | Redis Cluster |
| Audit | 文件/结构化日志 | PostgreSQL / ClickHouse 等 |
| Metrics | Prometheus | Prometheus + Grafana |
| Tracing | OpenTelemetry | OpenTelemetry |
| Core Business | Go | Go |
| AI/RAG | Python | Python |
| Config | YAML + ENV | Config Service / DB |
| Auth | Bearer Token | OAuth 2.1 / OIDC |
| Authorization | RBAC | RBAC + ABAC + Policy Engine |

---

# 6. MCP Gateway V1

## 6.1 V1 目标

V1 的目标不是做企业级平台，而是完成：

> 一个稳定的统一 MCP Endpoint + 多 MCP Server 聚合 + 基础权限 + 基础审计。

核心能力：

```text
Authentication
Authorization
Tool Registry
Tool Router
MCP Proxy
Server Registry
Health Check
Audit Log
```

---

## 6.2 V1 架构

```text
AI
│
│ HTTPS
▼
Nginx
│
▼
MCP Gateway
│
├── Auth
├── RBAC
├── Registry
├── Router
├── Proxy
├── Audit
└── Health
│
├── Dev MCP
├── Infra MCP
└── Blog MCP
```

---

## 6.3 V1 MCP Servers

### Dev MCP

```text
git_status
git_log
git_pull

github_issue_list
github_pr_list
github_pr_create
```

### Infra MCP

```text
server_info
disk_usage
memory_usage

docker_ps
docker_logs
docker_restart
```

### Blog MCP

```text
blog_search
blog_get
blog_create
blog_update
blog_publish
```

---

## 6.4 V1 Tool 分级

| Level | 类型 | 示例 |
|---|---|---|
| L0 | 只读 | server.info |
| L1 | 低风险写 | blog.create |
| L2 | 敏感操作 | docker.restart |
| L3 | 生产操作 | deploy.production |

V1 至少实现：

```text
Tool
 ├── name
 ├── description
 ├── inputSchema
 ├── capabilityLevel
 └── requiredScopes
```

---

## 6.5 V1 权限

第一阶段使用：

```text
Bearer Token
+
RBAC
```

角色：

```text
viewer
developer
operator
admin
```

权限示例：

```text
server:read
docker:read
docker:write
git:read
git:write
blog:read
blog:write
deploy:production
```

---

## 6.6 V1 Server Registry

使用 YAML：

```yaml
servers:
  - id: dev
    name: Development MCP
    transport: streamable-http
    url: http://dev-mcp:3001/mcp

  - id: blog
    name: Blog MCP
    transport: streamable-http
    url: http://blog-mcp:3002/mcp

  - id: infra
    name: Infrastructure MCP
    transport: streamable-http
    url: http://infra-mcp:3003/mcp
```

Gateway 启动：

```text
读取配置
 ↓
连接 MCP Server
 ↓
Capability Discovery
 ↓
Tool Discovery
 ↓
Tool Registry
```

---

# 7. V1 项目目录

```text
mcp-gateway/
│
├── src/
│   ├── main.ts
│   │
│   ├── server/
│   │   ├── mcp-server.ts
│   │   └── transport.ts
│   │
│   ├── auth/
│   │   ├── authentication.ts
│   │   ├── authorization.ts
│   │   └── identity.ts
│   │
│   ├── registry/
│   │   ├── server-registry.ts
│   │   ├── tool-registry.ts
│   │   ├── resource-registry.ts
│   │   └── prompt-registry.ts
│   │
│   ├── router/
│   │   └── tool-router.ts
│   │
│   ├── proxy/
│   │   └── mcp-proxy.ts
│   │
│   ├── policy/
│   │   ├── policy-engine.ts
│   │   └── rules.ts
│   │
│   ├── session/
│   │   └── session-manager.ts
│   │
│   ├── audit/
│   │   └── audit-log.ts
│   │
│   ├── health/
│   │   └── health-check.ts
│   │
│   └── config/
│       └── config.ts
│
├── config/
│   └── servers.yaml
│
├── tests/
├── Dockerfile
├── docker-compose.yml
├── package.json
├── pnpm-lock.yaml
├── tsconfig.json
└── README.md
```

---

# 8. V1 请求流程

以 `docker_logs` 为例：

```text
AI Client
   │
   │ tools/call
   ▼
MCP Gateway
   │
   ├── Authentication
   │
   ├── Authorization
   │
   ├── Policy Check
   │
   ├── Audit Start
   │
   └── Tool Router
           │
           ▼
       Infra MCP
           │
           ▼
        Docker
           │
           ▼
        Result
           │
           ▼
       Audit End
           │
           ▼
       AI Client
```

---

# 9. V2：治理与规模化

## 9.1 V2 目标

V2 从：

> MCP Gateway

升级为：

> **AI Capability Gateway**

重点解决：

- 多用户
- 多 Agent
- OAuth
- RBAC / ABAC
- Tool Policy
- Rate Limit
- Human Approval
- 动态 Server Registry
- Audit
- Metrics
- Tracing
- Tool Versioning
- 高可用

---

## 9.2 V2 架构

```text
                         AI Clients
                              │
                              ▼
                       Load Balancer
                              │
                ┌─────────────┴─────────────┐
                │                           │
                ▼                           ▼
          Gateway Instance A          Gateway Instance B
                │                           │
                └─────────────┬─────────────┘
                              │
                    ┌─────────┼─────────┐
                    ▼         ▼         ▼
                  Redis     Policy     Audit
                            Engine
                              │
          ┌───────────────────┼───────────────────┐
          ▼                   ▼                   ▼
       Dev MCP             Blog MCP             AI MCP
          │                   │                   │
        GitHub               Go API             Python
```

---

## 9.3 V2 身份体系

升级：

```text
Bearer Token
```

到：

```text
OAuth 2.1
+
OIDC
```

身份模型：

```text
User
 ↓
Identity Provider
 ↓
Access Token
 ↓
MCP Gateway
 ↓
Scopes / Roles / Policies
```

---

## 9.4 V2 RBAC + ABAC

RBAC：

```text
admin
operator
developer
viewer
```

ABAC：

```text
user
client
environment
tool
resource
time
riskLevel
```

示例：

```text
允许：
developer
+
blog:publish
+
staging
```

禁止：

```text
developer
+
deploy.production
```

---

# 10. V2 Policy Engine

建议统一：

```text
Policy
├── subject
├── action
├── resource
├── environment
├── condition
└── effect
```

例如：

```yaml
- name: production-deploy
  subject:
    role: operator

  action:
    - deploy:production

  resource:
    environment: production

  condition:
    requireApproval: true

  effect: allow
```

最终形成：

```text
Tool Call
 ↓
Policy Engine
 ↓
Allow
Deny
Require Approval
```

---

# 11. V2 Human Approval

高风险操作：

```text
AI
 ↓
deploy.production
 ↓
Policy Engine
 ↓
Require Approval
 ↓
Human
 ↓
Approve
 ↓
Tool Execution
```

Approval 对象：

```json
{
  "approvalId": "apr_xxx",
  "tool": "deploy.production",
  "requester": "agent_xxx",
  "riskLevel": 3,
  "status": "pending"
}
```

---

# 12. V2 Rate Limit

限制维度：

```text
User
Client
Agent
Tool
IP
Tenant
```

例如：

```text
server.info
100 req/min

docker.logs
30 req/min

deploy.production
5 req/hour
```

Redis 用于分布式 Rate Limit。

---

# 13. V2 Observability

引入：

```text
OpenTelemetry
Prometheus
Grafana
Structured Logging
```

监控：

```text
Tool Call Count
Tool Error Rate
Tool Latency
MCP Server Availability
Gateway Latency
Authentication Failure
Authorization Denied
Approval Time
```

请求追踪：

```text
traceId
requestId
sessionId
toolCallId
```

---

# 14. V2 Tool Versioning

Tool 不应该永久只有：

```text
blog.publish
```

建议：

```text
blog.publish
```

通过 metadata 管理版本：

```text
version: 1
status: stable
```

未来：

```text
blog.publish
v1
v2
```

兼容策略：

```text
stable
deprecated
experimental
```

---

# 15. V3：平台化 / Enterprise AI Gateway

## 15.1 V3 目标

V3 不再只是 MCP Gateway。

定位升级为：

> **Enterprise AI Gateway / AI Capability Platform**

核心能力：

```text
Multi-Tenant
Capability Marketplace
Policy-as-Code
Dynamic Discovery
AI Agent Management
Workflow
Approval
Observability
Billing / Quota
High Availability
Multi-Region
```

---

# 16. V3 总体架构

```text
                         AI Applications
      ┌──────────────────────┼──────────────────────┐
      │                      │                      │
   Copilot                Agent                  Workflow
      │                      │                      │
      └──────────────────────┼──────────────────────┘
                             │
                     AI Gateway / MCP
                             │
        ┌────────────────────┼────────────────────┐
        │                    │                    │
   Identity                 Policy             Registry
        │                    │                    │
        └────────────────────┼────────────────────┘
                             │
                    Capability Router
                             │
      ┌──────────────┬───────┼────────┬──────────────┐
      ▼              ▼       ▼        ▼              ▼
   Dev MCP        HR MCP   OA MCP  Finance MCP    AI MCP
      │              │       │        │              │
      ▼              ▼       ▼        ▼              ▼
   GitHub           HR      OA      Finance        RAG/LLM
      │
      └──────────────────────────────────────────────┐
                                                     ▼
                                              Enterprise APIs
```

---

# 17. V3 Multi-Tenant

数据模型：

```text
Tenant
 ├── Users
 ├── Agents
 ├── MCP Servers
 ├── Tools
 ├── Policies
 ├── Secrets
 ├── Quotas
 └── Audit
```

逻辑隔离：

```text
Tenant A
 ├── Agent A1
 ├── Agent A2
 └── Tools

Tenant B
 ├── Agent B1
 ├── Agent B2
 └── Tools
```

任何 Tool Call 都携带：

```text
tenantId
userId
agentId
clientId
sessionId
```

---

# 18. V3 Capability Marketplace

最终可以建立：

```text
Capability Marketplace
│
├── GitHub
├── Git
├── Docker
├── MySQL
├── Redis
├── MinIO
├── Slack
├── Feishu
├── Enterprise HR
├── Finance
├── CRM
└── AI / RAG
```

每一个 Capability 包含：

```text
Name
Description
Version
Provider
Tools
Resources
Required Scopes
Risk Level
Pricing / Quota
Health
```

实现：

```text
Install
Enable
Disable
Upgrade
Rollback
```

---

# 19. V3 Agent Management

Gateway 不再只管理 MCP Client。

开始管理 Agent：

```text
Agent
├── Identity
├── Tools
├── Permissions
├── Policy
├── Memory
├── Model
├── Quota
└── Workflow
```

例如：

```text
DevOps Agent

Model:
Qwen / Claude / GPT

Tools:
git.*
docker.*
server.*

Permissions:
server:read
docker:read
deploy:staging

Production:
Require Approval
```

---

# 20. V3 Policy-as-Code

策略独立于代码：

```text
Agent
 ↓
Policy
 ↓
Capability
 ↓
Tool
 ↓
Resource
```

可以逐步演进到：

```text
Policy Service
```

支持：

```text
RBAC
ABAC
Risk Based Access Control
Time Based Access
Environment Based Access
Approval Policy
Data Policy
```

---

# 21. V3 高可用

Gateway：

```text
Gateway × N
```

前面：

```text
Load Balancer
```

共享：

```text
Redis
PostgreSQL
Object Storage
```

架构：

```text
              Load Balancer
                    │
       ┌────────────┼────────────┐
       ▼            ▼            ▼
   Gateway A    Gateway B    Gateway C
       │            │            │
       └────────────┼────────────┘
                    │
          ┌─────────┼─────────┐
          ▼         ▼         ▼
        Redis    PostgreSQL  Object Storage
```

---

# 22. V3 Kubernetes

当 MCP Server 数量、用户数量、Agent 数量达到一定规模后，可以从：

```text
Docker Compose
```

升级：

```text
Kubernetes
```

但不应该 V1 就 Kubernetes。

推荐：

```text
V1 → Docker Compose
V2 → Docker / Kubernetes 可选
V3 → Kubernetes
```

---

# 23. 安全架构演进

```text
V1
Bearer Token
+
RBAC
+
Audit
```

↓

```text
V2
OAuth 2.1
+
OIDC
+
RBAC / ABAC
+
Policy Engine
+
Human Approval
+
Rate Limit
```

↓

```text
V3
Zero Trust
+
Multi-Tenant Isolation
+
Policy-as-Code
+
Secret Management
+
Risk Engine
+
Data Governance
+
Continuous Audit
```

---

# 24. Secrets 管理

禁止：

```text
API Key 写进代码
```

禁止：

```text
Git Repository
```

V1：

```text
.env
Docker Secrets
```

V2：

```text
Vault / Cloud Secret Manager
```

V3：

```text
Enterprise Secret Management
+
Key Rotation
+
Short-lived Credentials
```

---

# 25. 数据流架构

```text
AI Request
    │
    ▼
Authentication
    │
    ▼
Authorization
    │
    ▼
Policy
    │
    ▼
Tool Registry
    │
    ▼
Tool Router
    │
    ▼
MCP Proxy
    │
    ▼
Target MCP
    │
    ▼
External System
    │
    ▼
Result
    │
    ├── Audit
    ├── Metrics
    └── Trace
    │
    ▼
AI Response
```

---

# 26. 错误处理规范

统一错误模型：

```json
{
  "code": "TOOL_EXECUTION_FAILED",
  "message": "Deployment failed",
  "requestId": "req_xxx",
  "tool": "deploy.production",
  "retryable": false
}
```

错误分类：

```text
AUTHENTICATION_FAILED
AUTHORIZATION_DENIED
POLICY_DENIED
TOOL_NOT_FOUND
MCP_SERVER_UNAVAILABLE
TOOL_EXECUTION_FAILED
TIMEOUT
RATE_LIMITED
APPROVAL_REQUIRED
INVALID_ARGUMENT
```

---

# 27. Timeout / Retry / Circuit Breaker

V2 开始统一：

```text
Timeout
Retry
Circuit Breaker
Bulkhead
```

例如：

```text
AI
 ↓
Gateway
 ↓
Blog MCP
 ↓
超时
 ↓
Retry
 ↓
仍失败
 ↓
Circuit Breaker
```

避免单个 MCP Server 故障拖垮 Gateway。

---

# 28. Tool Design 规范

每个 Tool 必须定义：

```text
name
description
inputSchema
outputSchema
requiredScopes
riskLevel
timeout
idempotent
sideEffects
version
```

例如：

```yaml
name: deploy.production

description: Deploy application to production

riskLevel: 3

requiredScopes:
  - deploy:production

timeout: 300s

idempotent: false

sideEffects:
  - deployment
  - container_restart
```

---

# 29. Tool 命名规范

推荐：

```text
domain.action
```

例如：

```text
git.status
git.pull

github.issue.list
github.pr.create

docker.ps
docker.logs
docker.restart

server.info
server.disk

blog.search
blog.publish

deploy.staging
deploy.production
```

避免：

```text
doSomething
execute
run
shell
```

尤其禁止把：

```text
shell(command)
```

作为通用生产 Tool。

---

# 30. 高风险 Tool 设计

禁止：

```text
shell(command: string)
```

推荐白名单：

```text
docker.restart
git.pull
deploy.production
nginx.reload
```

如果确实需要命令执行：

```text
Command
 ↓
Allowlist
 ↓
Argument Validation
 ↓
Policy
 ↓
Approval
 ↓
Execute
```

---

# 31. Deployment 架构

V1：

```text
GitHub
 ↓
Git Pull
 ↓
Docker Compose
```

V2：

```text
GitHub
 ↓
CI/CD
 ↓
Image Registry
 ↓
Deployment MCP
 ↓
Server
```

V3：

```text
GitHub
 ↓
CI/CD
 ↓
Artifact Registry
 ↓
Kubernetes
 ↓
Progressive Deployment
```

---

# 32. 与现有博客系统的集成

现有业务：

```text
Vue 3
 ↓
Go API
 ↓
MySQL
Redis
MinIO
Elasticsearch
```

MCP：

```text
AI
 ↓
MCP Gateway
 ↓
Blog MCP
 ↓
Go API
```

推荐 Tool：

```text
blog.search
blog.get
blog.create
blog.update
blog.publish
media.upload
```

不要：

```text
Blog MCP
 ↓
直接修改 MySQL
```

---

# 33. 与 Ollama / AI 系统集成

```text
AI Agent
 ↓
MCP Gateway
 ↓
AI MCP
 ↓
Python
 ↓
Ollama
 ↓
Qwen / Other Models
```

RAG：

```text
Document
 ↓
Parser
 ↓
Embedding
 ↓
Vector / Elasticsearch
 ↓
Retriever
 ↓
Reranker
 ↓
LLM
```

MCP Gateway 不负责实现 RAG 算法，只负责调用 AI Capability。

---

# 34. V1 → V2 → V3 演进路线

## V1：可用

目标：

> “一个入口访问多个 MCP。”

```text
MCP Gateway
├── Auth
├── RBAC
├── Registry
├── Router
├── Proxy
├── Audit
└── Health

MCP:
├── Dev
├── Infra
└── Blog
```

重点：

- 跑通 MCP
- Streamable HTTP
- Tool Discovery
- Tool Routing
- 基础权限
- Docker 部署
- 基础日志

---

## V2：可治理

目标：

> “让 MCP 成为可靠的 AI Capability Gateway。”

新增：

```text
OAuth 2.1
OIDC
RBAC
ABAC
Policy Engine
Rate Limit
Human Approval
Redis
OpenTelemetry
Prometheus
Grafana
Tool Versioning
Circuit Breaker
```

重点：

- 多用户
- 多 Agent
- 安全
- 审计
- 可观测
- 高可用

---

## V3：平台化

目标：

> “从 MCP Gateway 演进为 Enterprise AI Gateway。”

新增：

```text
Multi-Tenant
Capability Marketplace
Agent Management
Policy-as-Code
Workflow
Quota
Billing
Secret Management
Risk Engine
Data Governance
Kubernetes
Multi-Region
```

重点：

- 企业级
- 平台化
- 多租户
- Agent 管理
- Capability Marketplace
- AI OS 基础设施

---

# 35. 版本边界

## V1 不做

```text
❌ Kubernetes
❌ Multi-Tenant
❌ Billing
❌ Complex Workflow
❌ 自研 Agent Runtime
❌ 自研 LLM
❌ 大规模数据库
```

## V2 不急着做

```text
❌ Marketplace
❌ Multi-Region
❌ Billing
❌ Enterprise Workflow
```

## V3 才考虑

```text
✓ Multi-Tenant
✓ Marketplace
✓ Agent Platform
✓ Enterprise Policy
✓ Kubernetes
✓ Multi-Region
```

---

# 36. 推荐开发顺序

### Phase 1

```text
TypeScript
 ↓
Node.js
 ↓
MCP SDK v2
 ↓
Streamable HTTP
```

先跑通：

```text
tools/list
tools/call
```

---

### Phase 2

实现：

```text
Server Registry
Tool Registry
Tool Router
MCP Proxy
```

---

### Phase 3

加入：

```text
Authentication
RBAC
Audit
Health Check
```

---

### Phase 4

接入：

```text
Dev MCP
Infra MCP
Blog MCP
```

---

### Phase 5

Docker：

```text
docker-compose.yml
```

部署：

```text
Nginx
 ↓
MCP Gateway
```

---

### Phase 6

V2：

```text
OAuth
Policy
Redis
Approval
OpenTelemetry
Prometheus
```

---

### Phase 7

V3：

```text
Multi-Tenant
Marketplace
Agent Management
Kubernetes
Enterprise Policy
```

---

# 37. 最终架构定位

整个系统最终形成：

```text
                    Enterprise AI OS
                           │
                           ▼
                 AI Gateway / MCP
                           │
        ┌──────────────────┼──────────────────┐
        ▼                  ▼                  ▼
   Capability          Agent Platform      Policy
   Registry                                  Engine
        │                  │                  │
        └──────────────────┼──────────────────┘
                           ▼
                    Capability Router
                           │
      ┌────────────┬───────┼────────┬────────────┐
      ▼            ▼       ▼        ▼            ▼
     Dev          HR      OA      Finance        AI
     MCP          MCP     MCP       MCP          MCP
      │            │       │        │             │
      ▼            ▼       ▼        ▼             ▼
   GitHub         HR      OA      ERP/财务       RAG/LLM
```

最终核心理念：

> **MCP 是协议，MCP Server 是能力提供者，MCP Gateway 是统一入口和治理层，AI Gateway 是平台化演进方向。**

---

# 38. 最终技术路线

```text
2026
 │
 ├── V1
 │    TypeScript
 │    Node.js
 │    MCP SDK v2
 │    Streamable HTTP
 │    Docker Compose
 │
 ▼
2027
 │
 ├── V2
 │    OAuth / OIDC
 │    RBAC / ABAC
 │    Policy
 │    Redis
 │    Observability
 │    Approval
 │
 ▼
未来
 │
 └── V3
      Multi-Tenant
      Capability Marketplace
      Agent Platform
      Policy-as-Code
      Kubernetes
      Enterprise AI Gateway
      Enterprise AI OS
```

---

# 39. 架构决策总结

最终采用：

```text
MCP Gateway
= TypeScript + Node.js

MCP Protocol
= MCP 2026-07-28 + Streamable HTTP

Schema
= Zod

Local
= stdio

Remote
= Streamable HTTP

Business
= Go

AI / RAG
= Python

Cache
= Redis

Database
= 按业务域独立管理

Deployment
= Docker Compose → Kubernetes

Security
= Token → OAuth/OIDC → Zero Trust

Authorization
= RBAC → ABAC → Policy-as-Code

Architecture
= Gateway + Capability MCP + Business API
```

---

# 40. 最重要的架构原则

整个项目长期必须坚持以下边界：

```text
                    AI
                    │
                    ▼
              MCP Gateway
                    │
       ┌────────────┼────────────┐
       ▼            ▼            ▼
    Dev MCP      Infra MCP    Business MCP
       │            │            │
       ▼            ▼            ▼
      Git         Docker       Go API
                                  │
                    ┌─────────────┼─────────────┐
                    ▼             ▼             ▼
                  MySQL         Redis         MinIO
```

**Gateway 不做业务。**

**MCP Server 不直接承担整个企业业务。**

**业务逻辑归业务 API。**

**AI/RAG 能力归 Python AI Service。**

**MCP Gateway 负责统一连接、权限、路由和治理。**

这四条边界，是整个 V1 → V3 架构能够持续演进的基础。
