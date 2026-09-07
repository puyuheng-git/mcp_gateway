# MCP Gateway v1 Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development or superpowers:executing-plans. Steps use checkbox syntax. Do not create commits or branches: the user has not requested either.

**Goal:** Deliver one authenticated MCP endpoint aggregating Dev, Infra and Blog tools with v1 authorization, audit and health.

**Architecture:** Official SDK v2 owns the protocol. YAML owns server registration and trusted tool policy. Capability MCP processes own all external-system integration.

**Tech Stack:** Node.js 24, TypeScript 7, MCP SDK 2.0.0, Zod 4, YAML 2, pnpm 11, Vitest 5, Biome 2, Docker Compose, Nginx.

**Spec:** `docs/superpowers/specs/2026-09-06-mcp-gateway-v1-design.md` and `MCP_Gateway_技术架构设计_v1.0.md`.

**Verification status (2026-09-07):** Implementation and local checks pass (13 test files / 210 tests plus built HTTP smoke). Container runtime, independent built CLI processes and real external integrations remain unverified. See `docs/verification.md` for commands, evidence and prerequisites. Unchecked final items are deployment-verification gaps, not claims of completed runtime acceptance.

## Global Constraints

- Gateway 不做业务；Blog MCP 仅调用 Go API。
- 无任意 shell 工具；无凭据硬编码；生产工具默认拒绝；不自动重试 tools/call。
- 不创建 git 仓库、分支或提交；当前工作区原本仅有架构文档。
- 所有新增行为先编写针对性测试并观察失败，再实现并观察通过。
- 所有外部写操作测试使用临时资源或本地测试服务。

## Task 1: Trusted configuration and execution policy

Files: `src/config/*`, `src/auth/*`, `src/policy/*`, `src/audit/*`, `src/errors.ts`, `tests/config.test.ts`, `tests/auth-policy.test.ts`.

Produces `GatewayConfig`, `Identity`, `Authenticator.authenticate(header)`, `authorize(identity, policy)`, `PolicyEngine.check(identity, policy)`, `AuditLog.write(event)`.

- [x] Write configuration-default, invalid/duplicate credential, missing secret and name-collision tests.
- [x] Run configuration regression tests and include them in the full verification suite.
- [x] Implement defaults and schema/secret validation without logging values.
- [x] Write and run authentication, scope, risk and production-denial tests.
- [x] Implement and rerun both focused test files.

## Task 2: SDK gateway, registry, routing and transports

Files: `src/registry/*`, `src/proxy/*`, `src/router/*`, `src/server/*`, `src/session/*`, `src/health/*`, `src/main.ts`, `tests/gateway.test.ts`, `tests/registry.test.ts`.

Consumes Task 1. Produces `createGateway(config, env)` with `listen()` and `close()`, authenticated `/mcp` and `/health`, and unauthenticated `/health/live` and `/health/ready` probes.

- [x] Write registry tests for default-deny, naming, conflicts and validation.
- [x] Write integration fixtures with official SDK capability servers and local HTTP listeners.
- [x] Cover discovery, authorization, proxy results, audit, session binding, stdio and failure recovery with regression tests.
- [x] Implement registry and transport lifecycle, then routing and health.
- [x] Run focused tests and fix root causes; do not implement future-version features.

## Task 3: Dev and Infra capability adapters

Files: `src/capabilities/dev/tools.ts`, `src/capabilities/infra/tools.ts`, `tests/capability-dev-infra.test.ts`.

Consumes `defineTool` and `CapabilityTool` from `src/capabilities/types.ts` (owned by gateway implementer). Produces `createDevTools(options)` and `createInfraTools(options)` returning `CapabilityTool[]`.

- [x] Test real temporary Git repository reads and deny unknown repositories.
- [x] Test GitHub request contract with injected fetch and no real remote writes.
- [x] Test system reads and container allowlist enforcement; command execution must use fixed executable and argument arrays.
- [x] Implement all twelve tools and run `pnpm test tests/capability-dev-infra.test.ts`.

## Task 4: Blog API adapter

Files: `src/capabilities/blog/tools.ts`, `tests/capability-blog.test.ts`.

Consumes `defineTool` and `CapabilityTool`. Produces `createBlogTools(options)` returning `CapabilityTool[]`.

- [x] Test all five HTTP method/path/body mappings against local test HTTP API.
- [x] Test invalid IDs, missing configuration, auth, abort/timeout, redirection and API error sanitization.
- [x] Implement adapter with configurable base URL/articles path; never access a database.
- [x] Run `pnpm test tests/capability-blog.test.ts`.

## Task 5: Runnable services and deployment

Files: `src/capabilities/runtime.ts`, `src/capabilities/*/main.ts`, `config/*`, `scripts/*`, `Dockerfile`, `docker-compose.yml`, `deploy/*`, `README.md`, `docs/*`.

Consumes Tasks 1–4; produces independent HTTP/stdio capability services, safe setup and smoke scripts, runnable Compose topology and operating instructions.

- [x] Wire each executable to its adapters and shared HTTP/stdio runtime.
- [x] Write explicit YAML policies for seventeen tools, local and Compose endpoints.
- [x] Add secure secret generation, upstream configuration, health checks and TLS examples.
- [x] Verify compiled modules, source-level service startup and Compose configuration consumers rather than asserting documentation text.

## Task 6: Final integration verification

- [x] Run `pnpm typecheck`, `pnpm lint`, `pnpm test`, `pnpm build`.
- [x] Run built HTTP modules through the official SDK smoke path in one foreground process.
- [x] Run source-level stdio integration with real SDK child processes and environment-isolation checks.
- [ ] Verify independent built CLI processes, including the built stdio example, in an execution environment that supports this acceptance path.
- [x] Run base, TLS and all optional overlay `docker compose config --quiet` checks with explicit safe sample values where required.
- [ ] Run an isolated Compose container smoke test after Docker Engine becomes available.
- [x] Review boundary/security risks, fix tested findings, rerun verification and record exact results; the final targeted review found no confirmed remaining blockers in the three latest fixes.
- [x] Document external prerequisites and any tests that could not run; deliver without claiming unverified integrations.
