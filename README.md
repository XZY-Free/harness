# SnowHarness

AI 引导式「从想法到上线」的全生命周期开发平台。用户打开即聊天，AI 按内置 Skill 一步步引导，把一个想法变成可预览、可推代码、最终可部署上线的真实项目。

> 已作为子服务 `snow_harness/` 迁入公司 monorepo **python-service**（CNB → K8s 流水线）。
> 项目总纲 / 北极星 / 路线图见 [`docs/00-README.md`](docs/00-README.md)；架构见 [`docs/01-架构/00-总览与目标.md`](docs/01-架构/00-总览与目标.md)；开发计划与进度（含迁移记录）见 [`docs/02-开发计划与源码清单.md`](docs/02-开发计划与源码清单.md)。

## 当前能力（MVP 主链路已跑通）

聊需求 → AI 按 Skill 阶段引导 → 生成代码（写入工作区）→ 起静态服务预览（活网页嵌 iframe）→ push 到 Git 仓库。单租户、单体单镜像。

## 技术栈

- **框架**：Next.js 16（App Router）全栈单体
- **AI**：Vercel AI SDK 6 + `@ai-sdk/openai-compatible`（OpenAI 兼容端点，当前接阿里云百炼 qwen）
- **DB**：外部 MySQL + Drizzle ORM（`mysql2` 驱动，连接走 `DATABASE_URL`）
- **预览**：进程内静态 HTTP 服务 + iframe（PreviewManager，技术命门）
- **Git 交付**：simple-git（运行时依赖 `git` 二进制）
- **样式**：Tailwind CSS 4
- **容器化**：多阶段 `Dockerfile`（node:22-alpine），经 CNB 流水线构建并部署

## 浏览器（V10 双形态）

V10 起 SnowHarness 同时保留两种产品形态，不再提供服务器远程浏览器：

- **Web**：回归简单、低延迟的 iframe AppRuntime 预览（`/preview/{threadId}` 反向代理 + owner guard + token + CSP）。不内置任意外部网站浏览器。
- **macOS Desktop**：Electron + `WebContentsView` 完整承接原 V9 浏览器能力（用户直接操作本地 Chromium，AI 经结构化 RPC 操作同一 WebContents）。Desktop 离线时 Browser Tool 返回 `desktop_unavailable`，不启动 Server Chromium fallback。

> V9 的 Xvfb / FFmpeg / Pion WebRTC / TURN / Docker streamer / Server UserBrowserProfile 链路已全部删除。详见 [`docs/solutions/v10-macos-desktop-web-preview/`](docs/solutions/v10-macos-desktop-web-preview/)。

## 快速开始

```bash
# 1. 安装依赖（需 Node 20+ 与 pnpm）
pnpm install

# 2. 起一个本地 MySQL（开发用）
docker run -d --name snow-mysql \
  -e MYSQL_ROOT_PASSWORD=snowroot -e MYSQL_DATABASE=snow_harness \
  -p 3307:3306 mysql:8.0

# 3. 配置个人密钥（多环境机制见下方「环境变量」）
#    .env.development 已含本地默认：DB 指向上面的容器、LLM 端点 / 模型。
#    只需把你的 LLM 密钥放进个人覆盖文件（git 忽略、不入库）：
echo 'LLM_API_KEY=<你的 OpenAI 兼容端点密钥>' >> .env.development.local

# 4. 启动开发服务器
pnpm dev          # = APP_ENV=development，加载 .env.development(.local)
# 打开 http://localhost:3000
```

表结构在首次访问时由 `ensureSchema()` 自动建（`CREATE TABLE IF NOT EXISTS`），无需手动迁移。

其他脚本：`pnpm build`（生产构建）、`pnpm start`（生产启动）、`pnpm typecheck`（类型检查）。

## 怎么用

首页是左右双栏：左侧聊天、右侧预览。

1. 在左侧描述你想做的东西（需求阶段）。
2. 点顶部「下一步」推进 Skill 阶段：需求 → 技术方案 → 生成代码 → 启动预览 → 推送上线。
3. 到「生成代码」阶段，AI 用 `writeFile` 工具把文件写进会话工作区。
4. 右上角「启动预览」把项目跑成活网页。
5. 到「推送上线」阶段，填入 Git 仓库地址推送。

## Agent Studio 后台（Phase 4-4 切片 A）

后台管理入口在 `/studio`（与前台单页 chat `/` 分离），含 Skills / Analytics / Threads / Policies 四页。
受应用内 RBAC 门禁（`role → permission`，表 `Role` / `RolePermission` / `UserRole`）：

- `admin`：全部权限（看全局 analytics、任意 thread、policy 只读等）。
- `member`：受限（只看自己的 analytics / thread）。
- dev/test：默认用户自动获 admin（`SNOW_STUDIO_OPEN=true`），本地与既有测试零回归；生产强制 false，无角色 → `/studio` 403。

初始化：`pnpm db:migrate && pnpm db:seed`（灌示例 skill + admin/member 角色 + 默认 policy 配置行）。
Policies 页为只读展示（policy 已 DB 化，经解释器编译为运行时配置；编辑能力留后续切片）。

## 目录结构

```
app/
  page.tsx              首页（读会话历史与 step，渲染工作台）
  api/chat/route.ts     聊天：流式回复 + 持久化 +（codegen）行动协议工具
  api/skill/route.ts    Skill step 推进（next/prev）
  api/preview/route.ts  预览起停
  api/git/route.ts      Git 交付
components/
  workspace.tsx         双栏工作台 + 状态条 + 阶段推进 + 预览控制
  chat-panel.tsx        聊天面板（含工具调用渲染）
  preview-panel.tsx     预览面板（四态 + iframe）
  deliver-bar.tsx       Git 推送条
lib/
  ai/provider.ts        LLM provider（OpenAI 兼容，可换端点）
  ai/tools.ts           行动协议工具（writeFile）
  db/                   schema / client(MySQL, mysql2) / queries
  skill/steps.ts        Skill 状态机定义与各阶段系统提示
  preview/manager.ts    PreviewManager（起静态服务）
  git/deliver.ts        Git 交付逻辑（simple-git）
  workspace.ts          会话工作区文件操作（防路径穿越）
  auth.ts               单租户固定用户
docs/                   项目文档（总纲 / 架构 / 开发计划）
Dockerfile              容器镜像（多阶段，运行时含 git）
upstreams/              上游参考源（只读，git 忽略）
workspaces/             运行时生成的用户项目（git 忽略）
```

## 环境变量

### 多环境（APP_ENV）

用 `APP_ENV` 区分部署环境，取值 `development` / `test` / `production`（别名 `dev` / `prod`），与 `NODE_ENV`
解耦——`NODE_ENV` 无法区分 test 与 production 部署（构建态均为 production）。启动脚本会设好对应 `APP_ENV`：

| 脚本 | 环境 |
|---|---|
| `pnpm dev` | development（`next dev`） |
| `pnpm dev:test` | test |
| `pnpm build` / `build:test` / `build:prod` | 构建 |
| `pnpm start:test` / `start:prod` | 以对应环境起生产服 |

### 配置文件与优先级

加载优先级（高 → 低）：

1. **平台注入**（K8s / `docker -e`）/ 命令行 —— 进程启动前即存在，绝不被覆盖
2. `.env.{APP_ENV}.local` —— **个人密钥，git 忽略、不入库**
3. `.env.{APP_ENV}` —— 该环境的**非敏感默认**，提交到 git
4. `.env` / `.env.{NODE_ENV}` —— Next.js 自动加载

> ⚠️ **密钥（DB 密码、`LLM_API_KEY` 等）一律放 `.env.{APP_ENV}.local` 或由平台注入，不要写进入库的 `.env.{APP_ENV}`。**
> 运行时由 `instrumentation.ts` 校验必填项，缺失会 fail-fast 退出（不静默回落本地默认）。

### 变量表

| 变量 | 必填 | 说明 |
|---|---|---|
| `APP_ENV` | — | 部署环境标识；由启动脚本 / 平台注入，无需手填 |
| `DATABASE_URL` | ✅ | MySQL 连接串（如 `mysql://user:pass@host:3306/snow_harness`） |
| `LLM_API_KEY` | ✅ | LLM 密钥（放 `.env.{APP_ENV}.local`） |
| `LLM_BASE_URL` | | OpenAI 兼容端点（默认阿里云百炼 compatible-mode） |
| `SNOW_CHAT_MODEL` | | 主聊天 / 代码生成模型（默认 qwen-plus） |
| `SNOW_TITLE_MODEL` | | 标题模型（默认 qwen-turbo） |
| `SNOW_WORKSPACES_DIR` | | 工作区根目录（默认 `workspaces`） |

### V3.8：生产 runtime / 部署 / secret（可选，不配置则功能降级）

| 变量 | 必填 | 说明 |
|---|---|---|
| `RUNTIME_DEFAULT_TYPE` | | 默认 runtime 类型（`host` / `container`，默认 `host`）。container 需 docker 可用 |
| `RUNTIME_IMAGE` | | container 模式镜像（默认 `snow-harness-runtime:node22`） |
| `RUNTIME_MEMORY_LIMIT` | | 容器内存上限（默认 `512m`） |
| `RUNTIME_CPUS` | | 容器 CPU 上限（默认 `0.5`） |
| `RUNTIME_DEFAULT_QUOTA_CPU` | | 全局默认 per-thread CPU 配额 |
| `RUNTIME_DEFAULT_QUOTA_MEMORY` | | 全局默认 per-thread 内存配额 |
| `RUNTIME_DEFAULT_QUOTA_TIMEOUT_MS` | | 全局默认命令超时（ms） |
| `RUNTIME_NETWORK_POLICY` | | 全局默认网络策略（`open` / `allowlist` / `disabled`，默认 `open`） |
| `RUNTIME_NETWORK_ALLOWLIST` | | allowlist 模式允许的域名/IP（逗号分隔，如 `github.com,registry.npmjs.org`） |
| `SECRET_MASTER_KEY` | | secret 加密 master key（AES-256-GCM，32 字节 base64/hex/utf-8）。**未配置 → secretMount fail-closed** |
| `SECRET_MASTER_KEY_ID` | | master key 标识（用于 key 轮换识别，默认 `default`） |
| `DEPLOY_CICD_WEBHOOK_URL` | | CI/CD 部署 webhook URL。**未配置 → 部署工具明确错误** |
| `DEPLOY_CICD_STATUS_URL` | | CI/CD job 状态查询 URL（`{jobId}` 占位符） |
| `DEPLOY_CICD_API_TOKEN` | | CI/CD webhook 鉴权 token（放 `.env.{APP_ENV}.local`） |
| `DEPLOY_ENVIRONMENTS` | | 允许的部署环境列表（逗号分隔，默认 `staging,prod`） |
| `DEPLOY_TIMEOUT_MS` | | webhook 请求超时（默认 `30000`） |
| `DEPLOY_MAX_RETRIES` | | webhook 失败重试次数（默认 `3`） |

> ⚠️ **`SECRET_MASTER_KEY` / `DEPLOY_CICD_API_TOKEN` 是敏感密钥，一律放 `.env.{APP_ENV}.local` 或由平台 secret 注入，不要写进入库的 `.env.{APP_ENV}`。**

## 接手须知

- **大仓子服务**：本项目是 `python-service` 下的 `snow_harness/`，经 CNB 流水线（Node 构建按钮选 `snow_harness`）构建镜像、部署 K8s。详见 `docs/02` 的「迁移」一节。
- **单租户 MVP**：当前用户写死在 `lib/constants.ts`；多租户 / 公司 SSO 是阶段二，schema 已预留 `userId`。
- **DB**：外部 MySQL；连接经 `DATABASE_URL`，K8s 下用 secret 注入、不要写进镜像。建表是 `ensureSchema()` 幂等 DDL，无迁移工具。
- **Runtime 隔离（V3.8）**：host 模式（默认）是信任平台进程，networkPolicy=open / quotaEnforced=false **诚实标注不伪装**；container 模式经 docker `--network` / `--memory` / `--cpus` 硬隔离。per-thread 配额/网络策略覆盖**只能收紧不能放宽**。secret 经 AES-256-GCM 加密存储（`SECRET_MASTER_KEY` 未配置 → fail-closed），全链路脱敏（ToolRun output / 日志 / manifest 不含明文）。部署经 CI/CD webhook 交接，**不直接操作 K8s**。
- **预览运行时**：MVP 仅服务静态站点；真实 dev server 项目（Vite/Next）需在 `lib/preview/manager.ts` 补 spawn 子进程。部署形态下预览服务监听容器内动态端口，浏览器经 localhost 不可达——需 K8s service 暴露 / 预览路由方案（见 `01-架构` 演进点）。
- **选型差异与演进点**：见 `docs/02` 与 `docs/01-架构` 的演进点表——每处「先简化」都登记了升级方向，改造前先读。
