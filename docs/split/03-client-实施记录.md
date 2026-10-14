# nexharness-client 拆分实施记录（阶段③ · 前置改造 + 搬迁）

- 日期：2026-10-14
- 分支：`split/03-client`
- 口径：**改造与搬迁分离**——本步只做"页面数据 API 化"，不搬迁文件、不建新仓。

## 目标与设计

消除 app 页层（studio / chat）对服务端 lib 的直连 import：页面数据查询与登录态/权限判断全部走 HTTP 接口。设计遵循消费方模型 v4 的**轻量断言 + 接口兜底**：

| 构件 | 说明 |
|---|---|
| `GET /studio/api/context`（新） | principal + 8 菜单可见性 + **权限快照**（auth-center 预展开清单）+ auth-center 地址；401 / 403（无 studio.access）/ 503（身份中心不可达）全 fail-closed |
| `components/studio/studio-shell.tsx`（新） | 客户端外壳取代原 server layout：context 拉取、登录跳转、门禁页、导航与 Toast；React Context 下发快照 |
| `lib/client/studio-permissions.ts`（新） | 快照轻量断言：**直接复用 identity-client 纯函数**（evaluateSnapshot / coverageFromSnapshot），与服务端同评测语义（只做清单匹配、不做角色模板推导）；仅用于 UI 显隐 |
| `components/hooks/use-api-data.ts`（新） | 轻量取数钩子（兼容 apiSuccess / 旧 jsonOk 两类信封；保留 HTTP 状态与错误消息） |
| `components/auth/auth-gate.tsx`（新） | /chat 使用端客户端登录门禁（/api/user/current） |

安全边界：菜单与入口显隐只是 UX 层；一切数据与写操作仍由服务端 API（requireStudioAction / requireActionScope 实时授权）兜底。

## 页面改造清单（17 文件）

| 页面 | 改造后 |
|---|---|
| `app/studio/layout.tsx` | → 薄壳（renders StudioShell） |
| `app/studio/page.tsx`（总览） | 客户端计数：`/studio/api/skills` + `/admin/api/agents` |
| `app/studio/audit` | 客户端：`/studio/api/audit`（403 → 门禁页） |
| `app/studio/governance` | 客户端：既有 GET/PUT 端点 + 快照 canWrite |
| `app/studio/permission-rules` | 客户端：既有 GET/PUT 端点 + 快照 canWrite |
| `app/studio/skills` | 客户端：`/studio/api/skills?withSync=1` |
| `app/studio/skills/[id]` | 客户端：`/skills/[id]`（新增 syncInfo）+ `/versions` |
| `app/studio/resources` | 客户端：快照 4 断言 + 企业属性目录（纯词表） |
| `app/studio/agents/[agent_id]` | 客户端：control-plane-client（get / listContracts / getRevision）+ `/admin/api/deployment-routes` |
| `app/studio/operations` / `runtime` | 客户端：快照 AnyScope 断言（route.update / runtime.publish） |
| `app/studio/security` / `settings` | 客户端：auth-center 外链地址改由 context 下发 |
| `app/studio/capabilities` / `observability` | 去门禁（静态页；门禁移交 StudioShell） |
| `app/chat` × 2 | AuthGate 客户端门禁（UUID 校验与 notFound 保留在 server 壳） |

## 服务端配套

- `lib/error-codes.ts`：新增 `IDENTITY_SERVICE_UNAVAILABLE`（503, retryable）。
- `lib/studio/nav-visibility.ts`：提炼纯函数 `navVisibilityFromSnapshot`；删 `computeStudioNavVisibility` / `isNavVisible` / `getAllKnownActionCodes`。
- `lib/identity/enterprise-user.ts`：目录块拆出纯词表 `enterprise-attribute-catalog.ts`（浏览器侧可引用；原文件转导出保持兼容）。
- `app/studio/api/skills`：列表支持 `?withSync=1`；详情附 `syncInfo`。
- `AgentRevisionDTO`（contracts）+ `agent-admin-projection`：新增 `agent_interface_requirements`（详情页"员工资料/办理确认"展示用）。

## 删除（门禁薄壳退役，消费者归零）

- `lib/studio/page-auth.ts`、`lib/identity/page-session.ts`。

## 保留与备注（搬迁时处置）

- **Next 应用壳**：`app/layout.tsx`（品牌 metadata）、`app/login/page.tsx`（302 壳）、`app/page.tsx` 与 `analytics` / `artifacts`（重定向页）——Vite 迁移时由 index.html / 路由守卫承接重写，不参与数据 API 化。
- **components type-only import（7 处）**：audit-log-table（persistence/audit 类型）、user-action 系列（user-action-request）、runtime-capability-panel、tool-permission-selector 等——运行时零耦合，搬迁时随组件本地化类型。

## 验证（真实服务 + 真实库）

- `pnpm typecheck` / `lint` / `build` 全绿。
- **Studio 页面冒烟 25/25**（`tmp/studio-pages-smoke.mjs`）：未登录 → auth-center 跳转（returnTo 正确）；15 个页面渲染；建技能 → 详情页（新建 200 路径）；security/settings 外链指向 auth-center；/chat AuthGate 通过。
- 回归：消费方联调 **9/9** · 收尾轮综合验证 **7/7**。

## 第 2 步：搬迁（2026-10-14 完成）

**新仓**：`XZY-Free/nexharness-client`（public，全新历史，首提交 402c60f / 284 文件）。

### 搬迁清单

| 类别 | 内容 |
|---|---|
| Web 页层 | app/ 页面/布局/globals/图标 → `src/routes/`（react-router 路由表 src/app.tsx）+ `src/styles/globals.css` |
| 组件 | components/ 全量（零改源） |
| 客户端库 | lib/client、api-fetch、utils、i18n、control-plane-client（全量）、desktop 协议、identity-client 纯函数（evaluate + types）、action-codes、企业属性词表、branding 前端侧、runtime/thread-title 依赖链 |
| 桌面 | desktop/ 全量（57 跟踪文件）+ 构建脚本 ×3 + vite.desktop.config.ts |
| 资产 | public/brand、theme-init.js、图标 |

### 关键适配（零改源策略）

- **next shim 双解析**：`next/link`、`next/navigation` → `src/shims/`（Web 版基于 react-router；桌面沿用自有 shim），vite alias + tsconfig paths 同源，搬迁组件零 import 修改。
- `use client` 保留（Vite 下无操作；rollup MODULE_LEVEL_DIRECTIVE 告警已静默）。
- `process.env.NEXT_PUBLIC_NEX_BASE_PATH` 由 vite define 注入（与 NEX_BASE_PATH 同源）。
- **postcss.config.mjs（@tailwindcss/postcss）随迁**——漏拷曾致首轮无样式（冒烟截图发现）；补配后 CSS 产物 8KB→148KB 全量。
- 新增：ticket-exchange（引导期票据兑换）、runtime-config（auth-center 地址）、六个手写路由（login/not-found/route-error/studio-layout/studio-analytics/chat-thread）。
- 删除 brand-initial.tsx（server 组件；SPA 用 BrandProvider 直挂）。

### nexharness 侧收敛（API 服务化）

- 删除 219 项（app 页层/组件/桌面/pub 资产/middleware/桌面脚本）+ control-plane-client fetch 面 5 项。
- 保留（服务端值消费，两端各一份）：`lib/client`（activity 投影等）、`lib/control-plane-client/contracts`。
- 新增 `app/api/session/exchange`；package.json 移除桌面 scripts 与 main 字段。
- 验证：typecheck / lint / build 全绿（clean `.next`）。

### 验证（全绿）

- 客户端：typecheck / lint / build ✓；桌面 renderer 构建 ✓ + 桌面主进程 tsc ✓；**SPA 冒烟 15/15**（tmp/client-smoke.mjs：未登录跳转 → auth-center 登录 → 票据回跳 → exchange 落地 → chat/studio 全页 → 会话复用 → 未登录负向）。
- CI：nexharness-client 1m13s 绿（run 38574527707）。

### 桌面打包冒烟（2026-10-14 补做，完成）

- **工具链打通**：`pnpm.onlyBuiltDependencies`（electron/better-sqlite3/esbuild）声明后，
  `pnpm rebuild electron` 装配二进制（本地 @electron/get 缓存命中 43.4.1，零下载；electron 版本
  精确固定 43.4.1 对齐原仓）。
- **全链验证**：`build:desktop`（renderer + main/preload esbuild + package-app 组装）
  → `rebuild:desktop-native`（better-sqlite3 v13 N-API prebuilt 直接兼容 electron 43，免重建）
  → `electron-builder`（mac arm64 未签名测试包：dmg/zip 142M + blockmap；`electronDist` 本地复用）。
- **实机启动冒烟**：打包产物 `.app` 启动存活 12s、无严重错误、日志零告警。
  （受限沙箱环境需 `--no-sandbox`；真实桌面环境不受影响。）
- **两处修复**（客户端仓 ae5815d）：
  1. `build-desktop.mjs` 补 app-icon.icns 复制（main 以 `__dirname/../app-icon.icns` 加载，
     esbuild 产物不含静态资源——原仓既有告警）；
  2. `window.ts` 窗口 icon 按平台条件化——macOS 由 .app bundle 决定（icon 仅 Windows/Linux
     有效），且 Electron nativeImage 不支持 ic12/PNG 编码的新版 icns 解码，macOS 下不传。
- **边界**：`fs.Stats constructor is deprecated` 弃用告警来自依赖侧（electron 主进程 node 集成），
  非本项目代码；签名/公证链（CSC_LINK / APPLE_ID 等）待正式发布时配置。

### 备注

- dev 联调：client `pnpm dev`（:5173，代理 nexharness :3210）；auth-center 允许名单需含 `http://localhost:5173`。
- 桌面首次开发需放行 electron/better-sqlite3 构建脚本（pnpm 10 默认拦截；已用
  `pnpm.onlyBuiltDependencies` 固化，无需手动 approve-builds）。
- nexharness 侧 drizzle/co 旧桌面引用已随迁移清理。
