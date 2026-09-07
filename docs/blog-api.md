# Blog MCP HTTP API 约定

Blog MCP 是 Go 业务 API 的适配器，不包含博客业务数据库或业务权限实现。当前仓库没有真实 Go API 的 OpenAPI 文档和凭据；以下为可配置、已由本地 HTTP 测试夹具覆盖的默认约定，不代表已经完成真实业务联调。

## 地址与认证

配置 `BLOG_API_URL` 和 `BLOG_API_TOKEN`，或用 `BLOG_API_TOKEN_FILE` 引用单行 Secret 文件。同名直接值和 `_FILE` 不应同时设置。默认 `BLOG_REQUIRE_AUTH=true`，缺少认证配置时工具执行失败。

集合地址由根地址的路径与 `BLOG_ARTICLES_PATH` 拼接，后者默认 `/api/articles`：

```text
BLOG_API_URL=https://blog.example.com/backend
BLOG_ARTICLES_PATH=/api/articles
最终集合地址=https://blog.example.com/backend/api/articles
```

根地址必须是无内嵌凭据、query、fragment 的 HTTP(S) URL。路径仅允许 ASCII 字母、数字、点、下划线、波浪线和短横线组成的段；拒绝 `.`/`..` 段、百分号编码、反斜线、重复斜线。尾部单个斜线会归一化。不要通过工具参数控制 API 主机或路径。

请求只发送独立的业务 API Bearer Token，不使用 Gateway Token。生产环境使用 HTTPS。`BLOG_REQUIRE_AUTH=false` 仅用于明确接受匿名调用的可信测试服务，不应作为处理 401/403 的绕过手段。

## 路由映射

以下 `articles` 指配置后的集合地址。

| Tool | HTTP 请求 | 参数映射 |
|---|---|---|
| `blog.search` | `GET articles?q=&page=1&pageSize=20` | q 默认空字符串，page 从 1 开始，pageSize 为 1–100 |
| `blog.get` | `GET articles/:id` | id 为路径段 |
| `blog.create` | `POST articles` | JSON `{title, content, slug?, tags?}` |
| `blog.update` | `PATCH articles/:id` | JSON 仅包含提供的 title/content/slug/tags，不包含 id |
| `blog.publish` | `POST articles/:id/publish` | 不发送请求正文 |

输入约束：

- id：1–128 个 ASCII 字母、数字、下划线、短横线；slug 同样限制，长度上限 200。
- title：去除首尾空白后 1–200 字符。
- content：1–1,000,000 字符且不能全部为空白；保留原始空白。Gateway 请求总大小另受默认 1 MiB 限制，因此非 ASCII 内容通常先触发字节上限。
- tags：最多 20 个，各项去除首尾空白后 1–64 字符；`[]` 表示清空。
- update：至少提供一个可修改字段；不能用 `null` 代替省略。所有工具拒绝额外字段。

## 响应与故障

业务 JSON 不重写，能力服务将其放入 MCP `structuredContent.result`，文本内容是同一 `{ "result": ... }` 的 JSON。HTTP 204 对应 `result: null`。若业务 API 将失败封装为 HTTP 200 内的 `code` 字段，适配器不会自动推断该业务语义，需要按真实合约增加映射。

响应必须是 UTF-8 `application/json` 或 `application/*+json`，解压后最多 1 MiB。非 JSON、无效 UTF-8、超大响应及失败 HTTP 状态会返回脱敏错误。调用默认超时 10 秒，覆盖响应头与正文读取，并响应上游取消信号；代码级 `BlogOptions.timeoutMs` 可设 1–120,000 ms。

不跟随重定向、不自动重试，包括只读调用。取消或超时不能证明服务端事务回滚；重试 create/publish 前应查询真实业务状态。Gateway 会将上游工具失败统一脱敏，实际 HTTP 状态和业务正文不透出给客户端。

## 真实系统接入清单

1. 确认集合路由、分页字段、文章 DTO、发布动作及鉴权方式符合本文；不符合时只调整 Blog 适配层，不把业务逻辑移入 Gateway。
2. 创建最小权限服务账号和独立 API Token，确认草稿写入与发布权限边界。
3. 先在测试环境校验 search/get，再用测试文章验证 create/update/publish，不对生产文章执行验收写操作。
4. 检查 API 自身的权限、校验、审计与幂等行为；Gateway 的 RBAC 不能替代业务权限。
5. 再设置 `BLOG_API_URL` 与 Secret，重启 Blog MCP，并通过 Gateway 按 viewer/developer/operator 三种身份验收。

Docker 下宿主机服务地址不能写为容器的 `127.0.0.1`。使用可达的网络服务名或为当前平台明确配置的宿主地址。
