# NexHarness

AI 引导式「从想法到上线」的全生命周期开发平台。用户打开即聊天，AI 按内置 Skill 一步步引导，把一个想法变成可预览、可推代码、最终可部署上线的真实项目。

独立 git 仓；企业版通过私有分支维护（部署链路见部署侧配置）。

## 技术栈

- **框架**：Next.js 16（App Router）全栈单体
- **AI**：Vercel AI SDK 6 + `@ai-sdk/openai-compatible`（OpenAI 兼容端点）
- **DB**：MySQL + Drizzle ORM（`mysql2` 驱动，连接走 `DATABASE_URL`）
- **桌面端**：Electron（macOS；Web 侧 iframe 预览，桌面侧本地 Chromium 由 Desktop 客户端承接）
- **样式**：Tailwind CSS 4；lint / format 用 Biome
- **容器化**：多阶段 `Dockerfile`

## 快速开始

```bash
# 1. 安装依赖（Node 24 / pnpm）
pnpm install

# 2. 起一个本地 MySQL（端口与 .env.development 的 DATABASE_URL 对应）
docker run -d --name nex-mysql \
  -e MYSQL_ROOT_PASSWORD=nexroot -e MYSQL_DATABASE=nexharness \
  -p 3307:3306 mysql:8.0

# 3. 应用数据库迁移（drizzle-kit 读取 DATABASE_URL）
pnpm exec drizzle-kit migrate

# 4. 灌本地示例数据（可选）
pnpm db:seed

# 5. 配置个人密钥（git 忽略、不入库）
echo 'LLM_API_KEY=<你的 OpenAI 兼容端点密钥>' >> .env.development.local

# 6. 启动完整本地开发拓扑（Web + Control Plane Outbox Worker）
pnpm dev          # = APP_ENV=development，加载 .env.development(.local)
# 打开 http://localhost:3000
```

常用脚本：`pnpm typecheck`（类型检查）、`pnpm lint`（Biome）、`pnpm build`（生产构建）、`pnpm start`（生产启动）。
桌面端：`pnpm build:desktop`（构建）、`pnpm dev:desktop`（本地运行）、`pnpm package:desktop`（打包 macOS）。

## 环境变量

### 多环境（APP_ENV）

`APP_ENV` 取值 `development` / `test` / `production`，与 `NODE_ENV` 解耦。启动脚本已设好对应值：
`pnpm dev`（development，含 Outbox Worker）、`pnpm dev:web`（仅 Web）、`pnpm dev:test`、`pnpm build` / `build:test` / `build:prod`、`pnpm start:test` / `start:prod`。

### 加载优先级（高 → 低）

1. **平台注入**（K8s / `docker -e`）/ 命令行 —— 进程启动前即存在，绝不被覆盖
2. `.env.{APP_ENV}.local` —— **个人密钥，git 忽略、不入库**
3. `.env.{APP_ENV}` —— 该环境**非敏感默认**，提交到 git
4. `.env` / `.env.{NODE_ENV}` —— Next.js 自动加载

> ⚠️ 密钥（DB 密码、`LLM_API_KEY` 等）一律放 `.env.{APP_ENV}.local` 或由平台注入。
> 运行时 `instrumentation.ts` 会校验必填项，缺失即 fail-fast 退出（不静默回落本地默认）。

### 变量表

| 变量 | 必填 | 说明 |
|---|---|---|
| `APP_ENV` | — | 部署环境标识；由启动脚本 / 平台注入 |
| `DATABASE_URL` | ✅ | MySQL 连接串（如 `mysql://user:pass@host:3306/nexharness`） |
| `LLM_API_KEY` | ✅ | LLM 密钥（放 `.env.{APP_ENV}.local`） |
| `LLM_BASE_URL` | | OpenAI 兼容端点 |
| `NEX_CHAT_MODEL` / `NEX_TITLE_MODEL` | | 模型名 |
| `NEX_REASONING_EFFORT` / `NEX_MAX_OUTPUT_TOKENS` | | 模型推理参数 |
| `NEX_WORKSPACES_DIR` | | 工作区根目录（默认 `workspaces`） |
| `NEX_FILE_IMAGE_UPLOAD_MAX_MB` / `NEX_FILE_DOCUMENT_UPLOAD_MAX_MB` | | 图片 / 文档上传上限 |
| `NEX_CONTROL_PLANE_PUBLIC_URL` | | External Runtime 场景下平台网关回调的公开基地址 |
| `NEX_CONTEXT_HANDLE_SECRET` | | context_handle HMAC 签名密钥（生产必填，≥32 字符） |

运行时 / 部署 / secret（可选，不配置则功能降级）：`RUNTIME_DEFAULT_TYPE`、`RUNTIME_IMAGE`、`RUNTIME_MEMORY_LIMIT`、`RUNTIME_CPUS`、`RUNTIME_NETWORK_POLICY`、`RUNTIME_NETWORK_ALLOWLIST`、`SECRET_MASTER_KEY`（未配置 → secretMount fail-closed）、`DEPLOY_CICD_WEBHOOK_URL`、`DEPLOY_CICD_STATUS_URL`、`DEPLOY_CICD_API_TOKEN`、`DEPLOY_ENVIRONMENTS` 等；完整清单见 `.env.example`。

## 说明

- **认证**：所有环境统一使用数据库账号与可撤销会话；管理员由 `pnpm auth:bootstrap-admin` 显式初始化。
- **后台 worker**：入口在 `scripts/workers/`（hosted-provisioning / workspace-host / control-plane-outbox / runtime-dispatch-retry / tool-execution），生产以 `pnpm worker:start` 或各 `worker:*` 脚本运行。
- **目录**：`app/`（页面与 API 路由，`/api`、`/gateway`、`/runtime`、`/admin/api`）、`lib/`（运行内核 / 控制面 / 身份 / 持久化等）、`components/`、`desktop/`（Electron 客户端）、`drizzle/`（迁移）、`scripts/`（构建、worker 与运维脚本）。
