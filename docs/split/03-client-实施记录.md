# nexharness-client 拆分·前置改造实施记录（阶段③ 第 1 步）

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

## 下一步

合入 main → 动搬迁（`split/03-client` 第 2 步）：建 nexharness-client 新仓（Vite SPA）、搬迁 app 页层/组件/桌面/SDK、路由与数据层适配、桌面打包冒烟。
