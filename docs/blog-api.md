# Blog MCP HTTP API 约定

Blog MCP 是博客 Go 服务 `/api/v1/mcp` 的薄适配器。业务校验、分类/标签解析与审计在博客侧完成。

## 地址与认证

| 变量 | 说明 |
|---|---|
| `BLOG_API_URL` | 博客 API 根地址，例如 `http://127.0.0.1:8080` |
| `BLOG_ARTICLES_PATH` | 默认 `/api/v1/mcp/articles` |
| `BLOG_API_TOKEN` / `BLOG_API_TOKEN_FILE` | 博客配置的 MCP 服务 Token（`BLOG_MCP_TOKEN`），不是管理员 JWT |
| `BLOG_REQUIRE_AUTH` | 默认 `true` |

请求只发送 MCP 服务 Bearer Token，不使用 Gateway Token。

## 路由映射

| Tool | HTTP | 说明 |
|---|---|---|
| `blog.search` | `GET .../articles?keyword=&q=&page=&pageSize=` | `q` 会映射为 `keyword`（并双写兼容） |
| `blog.get` | `GET .../articles/:idOrSlug` | 数字按 id，否则按 slug（含草稿） |
| `blog.create` | `POST .../articles` | 见下方 body |
| `blog.update` | `PATCH .../articles/:id` | 局部字段，服务端合并 |
| `blog.publish` | `POST .../articles/:id/publish` | 无请求体 |

辅助（由博客直接提供，当前 Gateway 未封装工具）：

- `GET /api/v1/mcp/categories`
- `GET /api/v1/mcp/tags`

## Create body

```json
{
  "title": "标题",
  "content": "正文",
  "slug": "optional-slug",
  "summary": "optional",
  "cover": "optional",
  "categoryId": 31,
  "categorySlug": "tech-insight",
  "tagIds": [1],
  "tagSlugs": ["ai"],
  "status": 0
}
```

`categoryId` 与 `categorySlug` 至少提供一个。`status`：`0` 草稿，`1` 发布。

## Update body

至少提供一个字段。支持 `title` / `content` / `slug` / `summary` / `cover` / `categoryId` / `categorySlug` / `tagIds` / `tagSlugs` / `clearTags` / `status`。`id` 必须为数字字符串。

## 响应

业务信封 `{ "code", "message", "data" }`。HTTP 200 且 `code != 0` 时，适配器返回 `TOOL_EXECUTION_FAILED`（不回传上游 message 细节）。

## 接入清单

1. 博客 `config.yaml` / `BLOG_MCP_TOKEN` 配置非空服务 Token。
2. Gateway `.env`：`BLOG_API_URL`、`BLOG_API_TOKEN`（同值）、`BLOG_ARTICLES_PATH=/api/v1/mcp/articles`、`BLOG_REQUIRE_AUTH=true`。
3. 重启博客服务与 `mcp-blog`，用 viewer / developer / operator 验收。
