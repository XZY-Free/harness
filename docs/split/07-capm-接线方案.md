# nexharness 基于 capability-market 的完善方案（阶段⑥）

- 日期：2026-10-15
- 状态：**草案，待拍板**（D1–D4 决策点见 §4）
- 口径：nexharness = 消费方完善，**不重建** capability-market（下称 capm）已立权威的任何基础设施
- 上游依据：本会话对《智能体 Harness 工程指南 v1.1.0》三层+横切架构的核对结论，及对外部开源项目推荐清单的评估（终评见 §7）

---

## 1. 背景与边界

拆分完成后 nexharness 收敛为「接入层薄壳（201 route.ts：admin 125 / api 39 / gateway 16 / studio 12 / runtime 8 / preview 1）+ 编排层 + 智能体核心层 + 横切」。其中两大子系统的**存储与管理权威已在 capm**（2026-10-15 用户拍板）：

| 子系统 | capm 权威（已实现） | nexharness 角色 |
|---|---|---|
| 记忆-知识检索 | ES + Qdrant + Neo4j 三路召回 + 重排 + query rewrite；图谱工作台（含时序）；knowledge-processing 加工 worker；knowledge-eval 评估闭环 | 消费方（检索入口切换，见阶段 A） |
| 工具/技能/MCP 目录 | `capability_assets`（assetType = skill/tool/mcp 三型）；check-updates / sync / artifact 拉取；MCP server（`/api/mcp`）+ 治理域 | 同步镜像 + 运行时本地副本（推广已验证模式，见阶段 B） |
| 身份认证授权 | auth-center（identity-client 消费已完成） | 消费方（不变） |

本方案只做三件事：**接线**（把缺口接到权威上）、**推广**（把 skill 同步模式推广到 tool/mcp）、**升级**（横切按标准改造）。不新建向量/图谱/工具注册设施。

## 2. 现状盘点（代码核对结论，2026-10-15）

| 模块 | nexharness 现状 | 缺口 |
|---|---|---|
| 记忆子系统 | `lib/context/knowledge-queries.ts`：knowledge_base/document/revision/chunk/index 五表；`searchKnowledgeEvidence` 仅 `contentRedacted LIKE` 简易匹配（注释自认「生产向量/图谱后续阶段接入」） | **P0**：检索入口未接 capm 三路召回 |
| 技能同步 | `lib/skill/sync/`：capability-market-client（只调 `/api/capabilities` 族）+ sync-service（binding 对照 → checkUpdates 比 hash → 变了才下载导入 → 单 asset 失败不中断；不做定时/双向/删除）+ studio sync/unsync/publish/rollback | 无（已落地，作为范式） |
| 工具/MCP 同步 | sync-service 写死 `listSyncableSkills` | **P0**：未推广到 asset_type=tool/mcp（capm 侧三型已就绪） |
| 工具执法 | gateway `tool-calls`：schema_hash 校验 + capability catalog + effect 记录 | ~~hash 双侧计算~~ **已撤销（E3 核对：capm 无 schema_hash；schema_hash 属执行侧留本地，跨边界用 capm content_hash）** |
| 模型集成 | `lib/ai/provider.ts`：OpenAI 兼容（百炼 compatible-mode）+ 多 endpoint 熔断（3 次失败 → 60s 冷却，进程级） | 缺预算账本/路由策略（**P1**） |
| 输出治理 | schema 校验 + permission 准入 | 缺并行 guardrails 三道防线（**P1**） |
| 可观测性 | `lib/observability/`：trace/span/observation + 脱敏不变量（content-policy）；harness-execution-trace 投影 | 自有模型未按 OTel GenAI 语义约定导出（**P1**） |
| 编排/运行时 | job（Job→JobCommand→Invocation→Effect）+ lease/heartbeat/recovery + harness-loop + sandbox/network-policy | 跨服务故障矩阵未纳入同一 recovery 语义（**P2**） |

## 3. 阶段总览

| 阶段 | 内容 | 优先级 | 依赖 |
|---|---|---|---|
| 0 | 决策拍板（D1–D4） | — | 用户 |
| A | 记忆子系统接线（检索切 capm） | P0 | D1、D2 |
| B | 工具层推广（tool/mcp 同步 + annotations） | P0 | D3、D4 |
| C | 模型集成与输出治理增强 | P1 | — |
| D | 横切升级（OTel GenAI + 安全对标） | P1 | — |
| E | 编排层自检（Temporal 之辨 + 故障矩阵） | P2 | D1 |

## 4. 阶段 0：决策拍板（不动代码）

- **D1 运行时降级策略**（阶段 A/E 的前置）。建议分层，请拍板：
  - 定义类（工具/技能/MCP 目录）：后台同步镜像已在本地，**运行时不依赖 capm 在线**（skill 同步现有设计即此）；
  - 知识检索：实时调用 capm，不可达时返回明确「检索服务不可用」，**不静默降级为空结果**——与现有三分法（权限拒绝 / 索引不可用 / 确实无结果）对齐；
  - 身份：维持已有语义（auth-center 实时 fail-closed）。
- **D2 知识表归属**：nexharness 五表降级为「绑定 + 索引状态跟踪」（保留租户映射、发布状态、ACL 评估），内容与索引权威移 capm；或整表退役。建议前者（灰度可控）。
- **D3 MCP 形态**：nexharness gateway 对 hosted runtime 暴露 MCP 风格工具面（现有 tool-calls/schema_hash 即雏形）+ 作为 client 消费 capm `/api/mcp`；私有 registry 对齐官方 MCP Registry 的 server.json + OpenAPI 接口面（该对齐活在 capm 侧，nexharness 只消费）。
- **D4 tool/mcp 同步同构**：sync-service 参数化 asset_type，binding/checkUpdates/import 流程复用；「超级核心必要」项（harness 运行不可缺少）自留本仓，业务能力一律 capm 权威——自留边界需列举确认。

## 5. 实施阶段

### 阶段 A：记忆子系统接线（P0）

| # | 改动 | 说明 |
|---|---|---|
| A1 | 检索入口切换 | `searchKnowledgeEvidence` → capm `POST /api/knowledge-search/hybrid`（三路召回+重排；请求带 tenant context，capm access-filter 已做租户过滤）；本仓五表按 D2 降级 |
| A2 | 写入路径盘点 | admin `knowledge-bases` CRUD（125 个 admin route 之一）的消费方先查明（studio 已迁 client，管理台归属未明），再定「代理转发 vs 退役」；**先只读切换，写入双轨观察一个迭代** |
| A3 | 候选记忆→图谱 | memory-candidates 晋升链路对接 capm 图谱实体；对标 Graphiti bi-temporal（演化事实不物理删除、标 supersedes/失效边），与 capm revision 模型对齐 |

验证：`pnpm typecheck` / `lint` / `build` + 检索三态冒烟（有权 / 无权 / 服务不可用）+ 租户隔离对拍（同 query 两 tenant 结果不串）。
风险：付费 API（embedding/reranker）调用量随检索上线上升——遵守用户成本红线，检索冒烟集中少量脚本，单测全 mock。

### 阶段 B：工具层推广（P0）

| # | 改动 | 说明 |
|---|---|---|
| B1 | sync 参数化 | sync-service 增加 asset_type 参数（tool/mcp）；capm `capability_assets.assetType` 三型与 tool/mcp 详情分支已就绪，主要是 nexharness 侧推广 + binding 表按类型隔离 |
| ~~B2~~ | ~~schema_hash 上移~~ **撤销（E3）** | capm 侧无 schema_hash 概念（全仓零匹配），只有包级 `content_hash` + `toolManifest`；schema_hash 覆盖 nexharness 独有的 `executionContract`（执行侧身份），上移=反向耦合。**归属定稿：capm 管定义+版本（content_hash），nexharness 管执行侧冻结（schema_hash）；跨边界对齐用 content_hash**。零迁移、零中间态。 |
| B3 | annotations 入 catalog | MCP tool annotations（readOnlyHint / destructiveHint / openWorldHint）+ outputSchema 进 capability catalog，与 permission 执法联动（destructiveHint → 强制审批） |

验证：tool/mcp 同步四态对拍（new / changed / blocked / not_found）+ 跨边界版本身份一致性（capm content_hash 与绑定记录 remoteAssetId/version 对拍）。
前置待确认：capm `scope=syncable` 对 tool/mcp 的支持度（代码见 assetType 已支持，syncable scope 待联调验证）。

### 阶段 C：模型集成与输出治理增强（P1）

| # | 改动 | 说明 |
|---|---|---|
| C1 | 预算账本 | 现有熔断之上加轻量预算（per key/team 限额 + 降级链），账目落已有 usage-records / cost-aggregates——LiteLLM 模式内化，不引入外部服务 |
| C2 | 并行 guardrails | 输入 / 输出 / 工具调用三道校验并行跑、fail-fast（对标 OpenAI Agents SDK guardrails 模式） |

验证：单测 mock 全量 + 预算边界冒烟 + 付费调用集中管控复核。

### 阶段 D：横切升级（P1）

| # | 改动 | 说明 |
|---|---|---|
| D1 | OTel GenAI 导出 | trace/span/observation 增加 OTel GenAI 语义约定导出层（invoke_agent → chat → execute_tool 三 span 模式、gen_ai.conversation.id）；消费端对接 capm knowledge-eval 看板（Langfuse 自托管为备选） |
| D2 | 安全对标 | gateway principal / workload-token 对标 MCP Authorization（OAuth 2.1 + scope 限定 + 资源绑定）；沙箱评估 WarmPool 预热 + gVisor/Kata runtimeClassName（CNB K8s 现网评估后出 ADR，不盲目上） |

验证：span 类型/属性对拍（自有模型 ↔ gen_ai 语义）+ 授权冒烟 + 沙箱选型 ADR 文档。

### 阶段 E：编排层自检（P2）

| # | 改动 | 说明 |
|---|---|---|
| E1 | Temporal 之辨审计 | 核对 lease/heartbeat/recovery 覆盖「执行恢复」而非仅「数据恢复」；跨服务故障矩阵（auth-center 不可达 / capm 不可达 / 两者同时）纳入同一 recovery 语义 |
| E2 | 故障注入 | 冒烟脚本：停 capm → 验证运行中 job 行为符合 D1 拍板 |

验证：故障注入冒烟 + 恢复路径对拍。

## 6. 约束与红线

- 每阶段「写→验→报」：typecheck / lint / build + 冒烟全绿才 commit；零回归；
- 不改 main、不 force push、禁 `git add -A`；
- 企业线（enterprise/private-hr-integration）勿破坏；企业键/Nacos 开关不受影响；
- 付费 API（百炼 embedding/reranker）调用遵守成本红线：单测全 mock，真实调用集中在少量端到端脚本；
- 跨项目改动（capm 侧对接面、mcp registry 对齐）在两个仓库分别提交，先 capm 后 nexharness 消费。

## 7. 附录：外部推荐清单终评（本会话结论）

| 项目 | 决议 | 理由 |
|---|---|---|
| LangGraph + Temporal 插件 | 不采纳 | 编排自建（Job/Invocation/Effect 状态机），替换冲击核心不变量；Temporal 论点仅用作 E1 自检 |
| CrewAI / FlowGram / Microsoft Agent Framework | 不采纳 | 同上；CrewAI 的「确定性骨架（Flows）+ 智能体（Crews）」分层可作表述参考 |
| OpenAI Agents SDK | 不选型 | 官方已维护模式（feature complete，新应用导流 Agents API）；guardrails 并行校验模式可借鉴 |
| Mem0 / Zep / Graphiti | 不引入 | capm 已覆盖检索与图谱；Graphiti bi-temporal 为 A3 对标基准 |
| MCP | 标准对接 | 私有 registry 对齐官方 server.json + OpenAPI（capm 侧活） |
| Uber MCP Gateway | 对标治理模式 | 「发现≠暴露」（默认禁用 + owner 审批 + 变更 diff）+ response projection，落 B 阶段与 capm mcp 治理 |
| LiteLLM | 模式内化 | 预算/路由思路进 C1，不引服务 |
| vLLM | 不采纳 | 部署层决策，与 harness 架构无关 |
| Langfuse / Arize Phoenix | 备选 | OTel GenAI 为主（D1），Langfuse 为自托管备选看板 |
| OpenTelemetry GenAI Conventions | **采纳（标准）** | 全清单唯一标准级收益 |
| K8s Agent Sandbox | 评估项 | WarmPool 思路可借；其本身非隔离边界（靠 gVisor/Kata），D2 出 ADR |
