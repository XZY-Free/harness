# auth-center 提取清单（阶段②施工图）

- 日期：2026-10-14；状态：**v4（消费方模型定稿——nexharness 不保留身份副本）**
- 分支：`split/02-auth-center`（已建）
- 变更要点：用户拍板，nexharness 采用**与未来业务系统同一套消费模式**（接口 + 缓存 + 实时兜底）；**废弃 v3 的"只读引用面 / 双侧 fork / 企业扩展两侧留"方案**

## 一、总览

| 面 | 处理 |
|---|---|
| 模型 | **auth-center = 唯一权威**（19 表 + 全部评测算法 + 企业扩展 + 治理）；**nexharness = 纯消费方**（`identity-client`：HTTP + 缓存 + 本地清单匹配） |
| `lib/identity` 51 文件 | 搬 ~31 / 留 ~19（执法点薄壳 + 平台横切 + 运行时身份 + 设备）/ 删 1（见 §二） |
| 表 | 搬 19 张；`device` 1 张留；nexharness 仅留 **FK 目标 stub**（3 表 id 列，见 §四） |
| 新增接口（auth-center 提供） | 会话 introspect / resolve / revoke、权限快照、实时 authorize（单/批）、目录读（单/批）、登录跳转 |
| 认证 API/页面 | 全搬：`app/api/auth/[...operation]`（6 操作）、`app/login`、`app/setup-password`、`components/auth`（5 件） |
| 管理台 | studio settings 的用户/角色/权限子块 + `app/studio/api/settings/{users,users/[id]/roles,permissions}` 3 路由 + **agent 访问管理**（已定选 A） |
| 生命周期治理 | 全搬：8 个 identity 文件 + `app/admin/api/{deletion-requests,legal-holds,retention-policies,security-incidents}/*` + 6 表 |
| 消费点改造 | `resolver` 16 / `studio-access` 28 / `enterprise-user` 10 / `access-policy` 9 / agent 执行链企业调用 / 登录跳转 → 全部切 `identity-client` |

## 二、`lib/identity` 逐文件分类（v4）

### A. 搬 auth-center（31 件）

**认证 / 目录（17）**：`resolver`、`local-authentication`、`authentication-provider`、`password-strength`、`identity-extension`、`identity-extension-bootstrap`、`enterprise-profile-source`、`accept-enterprise-profile-observation`、`enterprise-user`、`enterprise-user-profile-queries`、`prepare-enterprise-user-context`、`enterprise-user-access-policy`、`enterprise-permission-groups`、`principal-binding-queries`、`user-identity-queries`、`settings-queries`、`tenant-queries`

**生命周期治理（8）**：`deletion-executor`、`deletion-planner`、`deletion-request-queries`、`deletion-store-adapter`、`deletion-store-config`、`legal-hold-queries`、`retention-policy-queries`、`security-incident-queries`

**评测 / 管理（6）**：`permission-context`（评测引擎）、`permission-management`（写面）、`role-templates`、`permission-directory`、`resource-scope`、`enterprise-authorization`

> 说明：v3 中"双侧各持"的三件套（role-templates / permission-directory / resource-scope）与 `enterprise-authorization` 随评测引擎**全量迁 auth-center**——消费方不再需要任何评测算法（快照已是展开结果）。

### B. 留 nexharness（19 件）

| 分类 | 文件 | 说明 |
|---|---|---|
| 执法点薄壳 | `authorization`（checkActionScope）、`studio-access`、`agent-call-permission`、`page-session` | 保留在调用点；内部改为调 `identity-client`（快照本地匹配 / 实时 authorize） |
| 平台横切 | `audit`、`audit-queries`、`idempotency`、`idempotency-queries` | 与用户身份无关 |
| 运行时身份 | `workload-token`、`workload-token-revocation-queries`、`service-identity`、`resolve-outbound-credential` | 服务/工作负载身份，非用户身份 |
| 设备 | `device-queries`、`device-signature`、`desktop-nonce-store` | 随桌面桥 |
| 平台运维 | `recovery-consistency-checker`、`recovery-drill-queries` | 非用户生命周期治理 |
| 供给 | `tenant-bootstrap` | **拆分**：策略摘要工具（computePolicyRulesHash 等，5+ 内核链引用）留内核（策略域）；租户行创建归 auth-center 供给流（§四开放点） |

### C. 删除（1）

`migrate-legacy-permissions.ts`（全仓无调用方，死代码）。

### D. 唯二的"共享物"（非逻辑副本）

1. **协议词表**：`action-codes.ts` 常量（action code 是两侧协议枚举——与 HTTP 状态码同理，属协议不属冗余）；
2. **FK 目标 stub**：`tenant` / `user_identity` / `principal_binding` 的 id 列定义（**104 处外键**——`tenant` 95 + `userIdentity` 6 + `principalBinding` 3——的数据库引用完整性需要；非数据、非逻辑、只加不删）。

## 三、消费机制（定稿建议，实现时可微调）

1. **会话**：`introspect` + 本地缓存 **30~60s**；登出立即清本实例缓存；禁用生效窗口 ≤ TTL；**实时操作绕过缓存**。
2. **权限**：快照 = **展开后的允许清单**（action → 具体资源 id / wildcard / self 标记），懒加载 + 缓存 **5~15min**；本地匹配 = 清单包含测试（无模板、无作用域推导）。**变更/敏感操作实时 `authorize`**。
3. **规则**：变更类操作 **100% 实时**（不降级）；读/浏览类走快照；auth-center 不可达 → 实时操作 fail-closed。
4. **目录读**：批量接口 + 分钟级缓存（显示名等）。
5. **负载估算**（回应"高频"关切）：auth-center 调用量 ≈ 活跃用户数 × 1~2 次 / 缓存周期——可忽略级；绝大多数请求在本地缓存完成。
6. **未来增强**：写时失效推送（权限变更主动失效快照）；会话机制备选"签名令牌本地验签"（撤销窗口 = 令牌 TTL）。

## 四、表与迁移

- 搬 19；`device` 留；FK stubs 3（不落 CREATE、外键保留）。
- **开放点 1**：FK stub 的 drizzle 迁移生成处理——实现时按 drizzle 能力定稿。
- **开放点 2**：tenant 供给流——auth-center 建租户 ↔ 内核基线（governance/policy）幂等供给的衔接与触发（部署/seed 期）——实现时定稿。

## 五、施工顺序（v4）

1. **建 auth-center**（新仓骨架：Hono `server/` + Vite React `web/`；端口 3100）：移植身份域（含评测引擎 / 口子 / 企业链 / 治理）+ 19 表迁移 + 消费方接口集（session / snapshot / authorize / directory）→ 手工冒烟。
2. **nexharness 消费化**：建 `identity-client`（HTTP + 缓存 + 匹配器）→ 领域分批切换（会话 → 目录 → 权限 → 企业链 / agent 执行链）→ 删除身份域代码（仅留 stubs）→ **每步 typecheck / lint / build + 双起联调**。
3. **双侧验证**：一起启动联调 + 冒烟（登录 / 工作台 / agent 调用 / studio）；两侧静态与构建全绿。
4. **导出与 CI**：auth-center 新仓完善 + 最小 CI。

## 五之二、注意（诚实声明）

- **auth-center 成为运行时依赖**：agent 执行链的授权/企业判定实时调用它；不可达时实时操作 fail-closed。——服务化模型的必然结果；企业部署规模 +1 Deployment（阶段④接线）。
- **一致性窗口**：读类权限 ≤ 快照 TTL；会话状态 ≤ 会话缓存 TTL；**变更类实时兜底**（安全不降级）。
- **开发姿势**：nexharness 运行/联调需与 auth-center 一起启动（既定）。

## 六、确认项（v4）

### 已定（用户已拍板）

- [x] **消费方模型**：nexharness 不保留身份只读面 / 算法副本 / 企业扩展；统一经 auth-center 接口消费
- [x] agent 访问管理 → **A**（搬 auth-center 管理台；nexharness studio 该功能移除/留跳转）
- [x] 企业扩展 → **全量单侧**（auth-center）
- [x] `migrate-legacy-permissions.ts` → 删除
- [x] 治理面（纯 API）干净随搬；权限数据天然单份（同库、定义权归 auth-center）

### 默认（不反对即按此）

- [ ] 缓存 TTL：会话 30~60s / 快照 5~15min / 目录分钟级；变更类操作实时清单（按 action codes 定）
- [ ] 会话机制 = introspect + 缓存（备选签名令牌，实现时再评估）
- [ ] auth-center dev 端口 3100、无 basePath；nexharness `/login` 302 壳；开发期 cookie 共享（localhost 同 host）
- [ ] `ExternalAuthZoneConfig` 类型暂留内核协议文件（阶段③随客户端）

### 待定（实现时定稿）

- [ ] FK stub 迁移生成（§四）
- [ ] tenant 供给流衔接（§四）
- [ ] 消费方 SDK 抽取时机（先内嵌 `identity-client`；后续可发布为包供知识库等复用）
