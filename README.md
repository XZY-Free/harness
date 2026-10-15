# NexHarness

AI 引导式「从想法到上线」全生命周期平台的**智能体运行层**（API 服务）。

平台按三仓拆分（阶段③ 完成，2026-10-14），本仓只承载**运行时与服务端**：

| 仓 | 职责 | 形态 |
|---|---|---|
| **nexharness**（本仓） | 智能体运行层：harness 循环、运行时调度、持久化、治理、交付 | Next.js Route Handler（纯 API，无页面） |
| **nexharness-client** | 客户端：使用端 Web SPA + 管理台 + Desktop（Electron）+ 客户端 SDK | Vite SPA |
| **auth-center** | 统一身份中心：登录 / 会话 / 用户目录 / 角色与授权 / 生命周期治理 | Hono API + Vite 门户 |

企业版通过各仓 `enterprise/private-hr-integration` 私有分支维护（部署链路见部署侧配置）。

## 架构总览

### 三仓边界（消费方模型）

nexharness 对身份域是**纯消费方**：不自建账号，通过 `identity-client` 调 auth-center（会话校验 / 权限快照 / 实时授权 / 用户目录 / 企业上下文装配）。前端一律经 HTTP API 访问本仓，不再有同仓页面。

```
client (Web SPA / Desktop)          auth-center (身份权威)
        │  HTTPS / SSE                        ▲
        ▼                                     │ 消费方接口
   nexharness（本仓，API 服务）────────────────┘
        │
        ├── harness loop（决策 → 行动 → 观测）
        ├── ExecutionRuntime（host / container）· PreviewRuntime
        ├── 持久化（MySQL + 工作区）
        └── Gateway / Runtime / Studio API
```

### harness 循环（核心）

`lib/runtime/harness-loop/` 是智能体主循环：每步由模型输出**一个结构化行动**（`HARNESS_NEXT_ACTION`），平台执行后回灌观测：

- 行动类型（`HARNESS_ACTION_TYPES`）：`knowledge.search` / `tool.call` / `agent.call` / `agent.resume` / `request_user_input` / `respond`
- 循环上限可配（`maxLoopSteps` / `maxAgentCalls` / `maxToolCalls` / `maxKnowledgeSearches`）
- 能力目录（capability catalog）约束可调用的工具与 Agent，模型不得编造工具或观测
- `request_user_input` 受可信身份拦截：员工身份由宿主可信上下文提供，禁止向用户索要工号 / 密码 / 令牌

### 运行时分层

- `ExecutionRuntime`：命令 / 测试执行。`HostExecutionRuntime`（宿主进程，带 rlimit / sandbox）与 `ContainerExecutionRuntime`（`docker exec`）两实现，由 `RUNTIME_DEFAULT_TYPE` 选择，`container` 不可用时 fail-closed。
- `PreviewRuntime`：用户项目预览的隔离运行（每 thread 独立端口 / 容器，空闲回收）。
- 网络策略（`network-policy`）、资源配额（`quota`）、Secret 挂载与脱敏独立成层。

### 主要领域模块（`lib/`）

| 模块 | 职责 |
|---|---|
| `runtime/` | harness 循环、执行 / 预览运行时、容器管理、Gateway、并发恢复 |
| `conversations/` | Thread / Turn / Goal / PendingInput / Fork / Steer / 事件投影与 SSE |
| `agents/` | Agent 注册、revocation、AgentCall 生命周期与投影 |
| `skill/` | Skill 目录仓库（磁盘 git 仓，非 DB 文本）、版本快照 |
| `capability/` `catalog/` | 能力目录与工具查询 |
| `governance/` `permission/` `security/` | 策略、工具权限、Secret 治理 |
| `deploy/` `publications/` `artifacts/` `files/` | 部署触发、发布物、制品与文件存储 |
| `workspace/` | Thread 工作区与 safe-path 保护 |
| `identity-client/` | auth-center 消费方客户端（唯一的身份数据入口） |
| `persistence/` `db/` | Drizzle schema 与查询层 |
| `observability/` `evaluation/` | 可观测与评测 |

## 技术栈

- **框架**：Next.js 16（App Router，仅 Route Handler：`/api`、`/gateway`、`/runtime`、`/preview`、`/studio/api`、`/admin/api`）
- **AI**：Vercel AI SDK 6 + `@ai-sdk/openai-compatible`（OpenAI 兼容端点）
- **DB**：MySQL + Drizzle ORM（`mysql2` 驱动，`DATABASE_URL`）
- **运行时隔离**：Docker（容器模式）/ 宿主进程（host 模式，rlimit + sandbox）
- **实时**：SSE
- **lint / format**：Biome
- **容器化**：多阶段 `Dockerfile`（Web + Worker 双形态）

## 快速开始

```bash
# 1. 安装依赖（Node 24 / pnpm）
pnpm install

# 2. 起本地 MySQL（端口对齐 .env.development 的 DATABASE_URL）
docker run -d --name nex-mysql \
  -e MYSQL_ROOT_PASSWORD=nexroot -e MYSQL_DATABASE=nexharness \
  -p 3307:3306 mysql:8.0

# 3. 应用迁移（drizzle-kit 读 DATABASE_URL）
pnpm exec drizzle-kit migrate

# 4. 灌示例数据（可选）
pnpm db:seed

# 5. 配置个人密钥（git 忽略）
echo 'LLM_API_KEY=<OpenAI 兼容端点密钥>' >> .env.development.local

# 6. 启动（Web + Control Plane Outbox Worker）
pnpm dev          # APP_ENV=development
```

常用脚本：`pnpm typecheck` / `pnpm lint` / `pnpm build` / `pnpm start`。
Worker：`pnpm worker:start` 或各 `pnpm worker:*`（见下）。

> **本地跑全套**还需 auth-center（`:3100`）与 client（`:5173`）；本仓 `.env.development` 的 `NEX_AUTH_CENTER_URL` 指向 auth-center。

## 环境变量

### 多环境（APP_ENV）

`APP_ENV` 取 `development` / `test` / `production`，与 `NODE_ENV` 解耦。
`pnpm dev`（development，含 Outbox Worker）、`pnpm dev:web`（仅 Web）、`pnpm build` / `build:test` / `build:prod`、`pnpm start:test` / `start:prod`。

### 加载优先级（高 → 低）

1. **平台注入**（K8s / `docker -e`）/ 命令行 —— 进程启动前即存在，绝不被覆盖
2. `.env.{APP_ENV}.local` —— **个人密钥，git 忽略、不入库**
3. `.env.{APP_ENV}` —— 该环境**非敏感默认**，提交到 git
4. `.env` / `.env.{NODE_ENV}` —— Next.js 自动加载

> ⚠️ 密钥（DB 密码、`LLM_API_KEY` 等）一律放 `.env.{APP_ENV}.local` 或由平台注入。
> 运行时 `instrumentation.ts` 校验必填项，缺失即 fail-fast 退出（不静默回落）。

### 变量表

| 变量 | 必填 | 说明 |
|---|---|---|
| `APP_ENV` | — | 部署环境标识；由启动脚本 / 平台注入 |
| `DATABASE_URL` | ✅ | MySQL 连接串 |
| `LLM_API_KEY` | ✅ | LLM 密钥（放 `.env.{APP_ENV}.local`） |
| `LLM_BASE_URL` | | OpenAI 兼容端点 |
| `NEX_CHAT_MODEL` / `NEX_TITLE_MODEL` | | 模型名 |
| `NEX_REASONING_EFFORT` / `NEX_MAX_OUTPUT_TOKENS` | | 模型推理参数 |
| `NEX_AUTH_CENTER_URL` | | auth-center 地址（登录跳转 / 会话校验 / 授权） |
| `NEX_CONTROL_PLANE_PUBLIC_URL` | | External Runtime 场景下平台网关回调基地址 |
| `NEX_CONTEXT_HANDLE_SECRET` | | context_handle HMAC 签名密钥（生产必填，≥32 字符） |
| `NEXHARNESS_WORKLOAD_TOKEN_SIGNING_SECRET` / `WORKLOAD_SIGNING_KEY_ID` | | Workload Token 签发密钥与 key id（fail-closed） |
| `NEX_WORKSPACES_DIR` | | 工作区根目录（默认 `workspaces`） |
| `NEX_FILE_IMAGE_UPLOAD_MAX_MB` / `NEX_FILE_DOCUMENT_UPLOAD_MAX_MB` | | 图片 / 文档上传上限 |

运行时 / 部署（可选，不配则功能降级）：`RUNTIME_DEFAULT`（`host` / `container`）、`RUNTIME_NETWORK_POLICY`、`RUNTIME_QUOTA_*`（CPU / 内存 / 磁盘 / 超时 / 句柄 / PID 上限）、`RUNTIME_DEGRADE_ON_DOCKER_UNAVAILABLE`、`DEPLOY_CICD_WEBHOOK_URL` / `DEPLOY_CICD_STATUS_URL` / `DEPLOY_ENVIRONMENTS` 等；完整清单见 `.env.example` 与 `lib/config.ts`。

## 说明

- **认证**：消费方模型——本仓不建账号；管理员由 auth-center 侧 `auth:bootstrap-admin` 初始化，本仓经 `NEX_AUTH_CENTER_URL` 校验会话。
- **Worker**：入口 `scripts/workers/`（`hosted-provisioning` / `workspace-host` / `control-plane-outbox` / `runtime-dispatch-retry` / `tool-execution` / `environment-lease-cleanup`），生产以 `pnpm worker:start` 或各 `worker:*` 运行。
- **目录**：`app/`（Route Handler：`/api`、`/gateway`、`/runtime`、`/preview`、`/studio/api`、`/admin/api`）、`lib/`（运行内核 / 控制面 / 身份消费 / 持久化等）、`drizzle/`（迁移）、`scripts/`（构建、worker 与运维脚本）、`docker/`（运行时镜像）、`deploy/`（部署材料）。
- **验证口径**（阶段①b 清场后）：`typecheck` / `lint` / `build` / 冒烟；CI 为最简四步。