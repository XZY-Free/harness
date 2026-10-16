# nexharness Harness 完善总方案（阶段⑥）

- 日期：2026-10-15 起草 / **2026-10-16 定稿**
- 状态：**已定稿，可进入实施**（D1–D7 + E1–E3 全部拍板，见 §7/§8；无待决项）
- 定位：本方案是阶段⑥的**总纲**。按《智能体 Harness 工程指南 v1.1.0》的「三层 + 横切」逐子系统做「现状核对 → OSS 对标 → 缺口 → 升级」；capm（capability-market）接线只是其中的**基础阶段（Phase 1）**，详见 `07-capm-接线方案.md`。
- 上游依据：本会话对外部开源项目推荐清单的核查与终评（§4 简表）；nexharness 代码现状为 2026-10-15 实际核对结论。

---

## 1. 架构基线与子系统完善度总评

nexharness 现状 = 接入层薄壳（201 route.ts：admin 125 / api 39 / gateway 16 / studio 12 / runtime 8 / preview 1）+ 编排层 + 智能体核心层 + 横切。逐子系统核对结果：

| 子系统 | 书中职责 | nexharness 现状（代码事实） | 完善度 |
|---|---|---|---|
| 编排层 | 任务分解 / 依赖 DAG / 多智能体协调 / 结果聚合 | `lib/job`（Job→JobCommand→Invocation→Effect 状态机 + worker + step effects）；AgentCall + child-thread 子智能体（loop 限 maxAgentCalls=3）；`lib/control-plane`；effect targets | **80%**：缺显式任务分解/DAG 表达与检查点语义文档化 |
| 运行时引擎 | 智能体循环 / 状态机 / 消息编排 / 异步执行 / 超时中断 / 漂移检测 / token 预算 / 实时控制平面 / 错误恢复 | `lib/runtime/harness-loop`：loop 预算内置（maxLoopSteps 12 / maxToolCalls 8 / maxKnowledgeSearches 6 / maxAgentCalls 3 / **maxConsecutiveSameAction 2 = 漂移控制**）；KnowledgeSearchAction 为 loop 一级动作；context 组装（fragment / budget-estimation / recent-item-context-policy / checkpoint）；steer / interrupt / heartbeat / cancel / resume；HarnessLoopRecoverySnapshot；retry lanes；`quota.ts`（per-thread 只能收紧） | **90%**：书第 4 章职责基本全覆盖，剩余为对标打磨项 |
| 工具层 | 注册 / 发现 / 参数验证 / 权限检查 / 执行隔离 / 结果标准化 | capability catalog + 快照校验（validateHarnessActionAgainstCatalog）；gateway `tool-calls`（schema_hash 校验 + effect 记录）；skill runtime + capm 同步（已落地）；sandbox / network-policy / quota | **75%**：tool/mcp 同步未推广；tool annotations 缺失 |
| 记忆子系统 | 工作记忆 / 短期记忆 / 长期记忆（含可写入式记忆） | 工作 = context 组装 + thread items/turns；短期 = thread/checkpoint/pending-inputs/projection/shared-budget；长期 = memory-entries + knowledge base（**仅 LIKE 检索**）+ memory-candidates（候选记忆） | **50%**：长期记忆检索后端与晋升链路缺失（Phase 1/2 补） |
| 模型集成与输出治理 | 模型抽象 / 提示词管理 / 输出解析验证 / 降级策略 | `lib/ai`：OpenAI 兼容（百炼 compatible-mode）+ 多 endpoint 熔断（3 失败→60s 冷却，进程级）；schema 校验 + permission 准入 | **60%**：缺预算账本 / 路由策略 / 并行 guardrails |
| 横切-安全 | 权限 / 沙箱 / 注入防护 / 审计 | permission + identity-client + crypto + secret-redaction + workload-tokens + audit-events | **80%**：对标 MCP Authorization / WarmPool（Phase 4） |
| 横切-可观测性 | 追踪 / 结构化日志 / 指标 / 告警 | `lib/observability`（trace/span/observation + 脱敏不变量）+ harness-execution-trace 投影 + audit | **70%**：自有模型未按 OTel GenAI 语义约定导出 |
| 横切-存储 | 持久化 / 缓存 / 审计存储 | `lib/persistence`（50 文件）+ db + files + artifacts + workspace | **90%**：knowledge 存储移交 capm 后本仓表瘦身 |
| 接入层 | 协议适配 / 身份认证 / 响应格式化 | 201 route 薄壳 + session exchange + 统一信封 + 幂等 | **95%**：保持薄，不倒退 |

**结论**：运行时引擎已相当完善（书第 4 章职责基本全覆盖）；**记忆子系统是最大短板**（长期记忆检索后端缺失）；工具层次之（推广问题）；模型集成与输出治理、可观测性是标准升级问题；编排层缺显式任务分解表达。

## 2. 逐子系统完善设计

### 2.1 编排层（80% → 目标 90%）

- **现状**：Job 状态机是生产级等价物（LangGraph 图状态机的自建版），多智能体协调靠 AgentCall + child-thread（限深限次），effect targets 已有 DAG 雏形。
- **对标**：LangGraph（图状态机 + 检查点——对照我们的 Job/Invocation 语义）；Temporal（durable execution 之辨，见 Phase 5 自检）；CrewAI（「确定性骨架 Flow + 智能体 Crew」分层表述，可入架构文档）；FlowGram（可视化编排，远期）。
- **升级项**：① 显式任务分解表达（子任务 DAG：effect targets 扩展为可声明依赖）；② 检查点/恢复语义文档化（Job 快照 ↔ LangGraph checkpoint ↔ Temporal history 三者对照）；③ 循环预算命中事件化（loop limits 触发时落 observation，服务可观测性）。
- **不采纳**：引入 LangGraph/Temporal/CrewAI/MAF 任一作为编排或运行时（冲击 Job→JobCommand→Invocation→Effect 锁顺序、lease 语义、hosted authority 逐项复核等核心不变量）。

### 2.2 运行时引擎（90% → 对标打磨）

**「是否完善」的明确回答**：书第 4 章职责逐项有对应实现——状态机管理（Job + loop states）、消息编排（context 组装）、异步执行（workers + transient-events + SSE）、超时与中断（interrupt/steer/quota timeout）、漂移检测（maxConsecutiveSameAction + loop 预算）、token 预算与上下文动态管理（context/budget + shared-budget + recent-item-policy）、实时控制平面（heartbeat/steer/control-plane）、错误恢复（recovery snapshot + retry lanes + mysql-recovery-port）。**没有缺失，只有打磨**：

- **对标 OpenAI Agents SDK**（模式参考，不选型——官方已维护模式）：handoffs 语义对照我们的 AgentCall/child-thread（handoff vs agent-as-tool 边界显式化）；guardrails 并行校验模式（进 Phase 3）；sessions 抽象对照短期记忆（Phase 2）。
- **对标 Temporal**：durable execution 之辨用于 Phase 5 自检（lease/recovery 覆盖「执行恢复」而非仅「数据恢复」）。
- **对标 Microsoft Agent Framework**：workflow checkpointing 语义可作检查点文档化的表述参考；群聊编排不采纳。
- **具体打磨项**：① 循环预算可观测化；② 短期记忆 compaction（上下文压缩）策略；③ KnowledgeSearchAction 的后端接线（即 Phase 1A——这是运行时唯一的「半成品」接口）。

### 2.3 工具层（75% → 目标 90%，Phase 1B + 3）

- **对标**：MCP（标准：私有 registry 对齐官方 server.json + OpenAPI 接口面，活在 capm 侧）；Uber MCP Gateway（治理模式：发现≠暴露——默认禁用 + owner 审批 + 变更 diff + response projection）；K8s Agent Sandbox（执行隔离评估，Phase 4D2）。
- **升级项**：① sync-service 参数化 asset_type=tool/mcp（capm `capability_assets.assetType` 三型已就绪）；② ~~schema_hash 上移 capm~~ **已撤销（E3 核对：capm 无 schema_hash 概念，且其覆盖 nexharness 独有的 executionContract，属执行侧身份应留本地；跨边界用 capm content_hash 作版本身份）**；③ MCP tool annotations（readOnlyHint/destructiveHint/openWorldHint）入 catalog 并与 permission 执法联动（destructiveHint→强制审批）；④ response projection（工具返回按需裁剪，压 context）。

### 2.4 记忆子系统（50% → 目标 85%，Phase 1A + 2）——本方案重点

按书的记忆三层 + 可写入式记忆逐层设计：

| 记忆层 | nexharness 现状 | OSS 对标 | 升级项 |
|---|---|---|---|
| **工作记忆**（上下文窗口） | context 组装：fragment / budget-estimation / recent-item-context-policy / checkpoint | OpenAI Agents SDK context 管理；各家长上下文压缩 | 预算策略显式化（token 预算 → 截断/压缩策略可配置）； compaction（Phase 2） |
| **短期记忆**（会话级） | thread/turn/items + projection + pending-inputs + shared-budget + pause/resume | OpenAI Agents SDK sessions；CrewAI 状态系统（dict + Pydantic 双模） | 会话摘要/压缩机制（compact）；会话状态 schema 化（对照 Pydantic 强校验） |
| **长期记忆**（持久化） | memory-entries + knowledge base（**LIKE 检索，注释自认生产检索后续接入**）+ memory-candidates（候选） | Mem0（user/agent/run 三级作用域向量记忆）；Zep/Graphiti（bi-temporal 时序图谱，supersedes 边） | ① 检索入口切 capm 三路召回（Phase 1A）；② 候选记忆晋升链路（Phase 2）；③ 作用域显式化（tenant/userIdentity/agent/run）；④ 遗忘策略（TTL/归档，对标 Mem0 整合遗忘） |
| **可写入式记忆**（书 6.2） | memory-candidates + gateway user-action-requests（人审机制已有） | Graphiti episode 写入；CrewAI 记忆整合 | 候选→人审→晋升→（图谱实体 / 记忆条目）全链路；演化事实不物理删除、标 supersedes/失效边（对标 Graphiti bi-temporal） |

**记忆存储权威**：所有持久化记忆（知识资产、图谱、向量索引、候选）存 capm（ES + Qdrant + Neo4j + knowledge-processing）；nexharness **不保留知识存储表**（D2 定稿：检索侧同接口换实现，admin 写入侧 + 五表退役），运行时只认 capm 返回的 `document:revision:chunk` 引用。**不在 nexharness 重建任何向量/图谱设施。**

### 2.5 模型集成与输出治理（60% → 目标 85%，Phase 3）

- **对标**：LiteLLM（统一网关：路由 / 预算 / 虚拟 key / 支出日志——模式内化，不引 Python 服务）；vLLM（不采纳：部署层决策）；OpenAI Agents SDK guardrails（并行校验 fail-fast）；MCP annotations（输出结构化 outputSchema）。
- **升级项**：① 熔断之上加预算账本（per key/team 限额 + 降级链，账目落已有 usage-records/cost-aggregates）；② 输入/输出/工具调用三道 guardrails 并行校验；③ 结构化输出契约（outputSchema 进 catalog）。

### 2.6 横切关注点（70–80% → 目标 90%，Phase 4）

- **可观测性**：自有 trace/span/observation → 增加 **OTel GenAI 语义约定导出层**（invoke_agent → chat → execute_tool 三 span 模式、gen_ai.conversation.id）；消费端对接 capm knowledge-eval 看板（Langfuse 自托管备选）。这是全清单唯一标准级收益。
- **安全**：gateway principal / workload-token 对标 MCP Authorization（OAuth 2.1 + scope 限定 + 资源绑定 + 升级认证）；沙箱评估 WarmPool 预热池 + gVisor/Kata runtimeClassName（CNB K8s 现网评估后出 ADR——K8s Agent Sandbox 本身非隔离边界、默认 authorizer AllowAll，别当开箱即安）。
- **存储**：knowledge 内容与索引移交 capm 后本仓五表瘦身；其余（db/files/artifacts/workspace）保持。

### 2.7 接入层（95%，保持）

201 route 薄壳 + session exchange + 信封 + 幂等，维持「薄而稳定」，不新增业务逻辑。SSE 传输（conversations/sse-transport）保持不变。

## 3. 实施阶段

| 阶段 | 内容 | 对应子系统 | 优先级 | 详规 |
|---|---|---|---|---|
| **Phase 1（基础）** | capm 接线：记忆检索切换 + tool/mcp 同步推广 + annotations | 记忆 / 工具层 | P0 | `07-capm-接线方案.md` |
| **Phase 2** | 记忆分层完善：compaction、候选晋升链路、作用域显式化、遗忘策略 | 记忆 | P0 | 本方案 §2.4，Phase 1 后细化 |
| **Phase 3** | 模型集成与输出治理：预算账本、并行 guardrails、outputSchema | 模型集成与输出治理 | P1 | 本方案 §2.5 |
| **Phase 4** | 横切标准升级：OTel GenAI 导出、安全对标、WarmPool ADR | 横切 | P1 | 本方案 §2.6 |
| **Phase 5** | 编排增强：Temporal 之辨自检、任务分解 DAG、检查点语义、循环预算事件化 | 编排 / 运行时 | P2 | 本方案 §2.1/2.2 |

每阶段内部照旧「写→验→报」：typecheck / lint / build + 冒烟全绿才 commit；零回归。

## 4. OSS 对标基准表（终评）

| 项目 | 决议 | 在方案中的角色 |
|---|---|---|
| OpenTelemetry GenAI Conventions | **采纳（唯一标准）** | Phase 4D1 导出层 |
| MCP（含官方 Registry 模式） | 标准对接 | 私有 registry 对齐（capm 侧）；工具定义标准 |
| Uber MCP Gateway | 对标治理模式 | 发现≠暴露 + owner 审批 + response projection（Phase 1B/3） |
| Graphiti / Zep | 对标基准 | bi-temporal supersedes 模型（Phase 2 晋升链路） |
| Mem0 | 对标基准 | 三级作用域 + 遗忘策略（Phase 2） |
| LiteLLM | 模式内化 | 预算账本（Phase 3） |
| OpenAI Agents SDK | 模式参考（不选型，官方维护模式） | guardrails 并行、handoffs 语义、sessions（Phase 2/3） |
| K8s Agent Sandbox | 评估项 | WarmPool 思路；隔离靠 gVisor/Kata，出 ADR（Phase 4D2） |
| LangGraph / Temporal / CrewAI / MAF / FlowGram / vLLM / Langfuse / Phoenix | 不采纳/备选 | Temporal 之辨作 Phase 5 自检；CrewAI Flows/Crews 作表述参考；FlowGram 远期可视化；Langfuse 备选看板 |

（各项目生产验证 claim 的核查结论见会话记录：MCP 捐 LF 属实、Uber 数字属实但非开源、K8s Sandbox 属实但非隔离边界、Agents SDK 已过时、CrewAI 数字为厂商自报。）

## 5. 决策点（D1–D7 + E1–E3 全部定稿，见 §7/§8；**无待决项**）

## 6. 约束与红线

- 付费 API（百炼 embedding/reranker/LLM）遵守成本红线：单测全 mock，真实调用集中少量端到端脚本；
- 每阶段 typecheck / lint / build + 冒烟零Regression；不改 main、不 force push、禁 `git add -A`；
- 企业线（enterprise/private-hr-integration）勿破坏；
- 跨项目改动（capm 侧对接面、registry 对齐）两仓分别提交，先 capm 后 nexharness 消费；
- 核心不变量不动：Job→JobCommand→Invocation→Effect 锁顺序、lease 语义、hosted authority 逐项复核、Observation 脱敏不变量。

## 7. 决策点定稿（2026-10-16 用户拍板）

### D1 运行时降级分层 —— ✅ 定稿（原建议）

按「本地有无副本」分三类：**A 定义类**（工具/技能/MCP 目录）本地已镜像，运行时不查 capm、capm 挂了只影响后台同步；**B 知识检索**实时调用，采用「明确报错 + 只读检索可降级为『无知识上下文 + observation 标注 `knowledge_unavailable`』」，**必须区分「服务不可达」与「没有相关知识」**；**C 身份**维持实时 fail-closed。

### D2 knowledge 五表归属 —— ✅ 定稿（退役，非双轨；2026-10-16 修正）

**代码事实（二次核对）**：区分了两类消费方——
- **真消费方（运行时活跃路径）**：`knowledge.search` 执行器（`platform-action-executors.ts`）与 `KnowledgeResolver`（`source-resolvers.ts`）经 `buildDefaultResolvers()` 已注册，接的是**本地 LIKE 实现**（半成品）。
- **零消费方**：`app/admin/api/knowledge-bases/*` 共 10 个路由，全仓（含 nexharness-client 仓、scripts）**无任何调用方**。

**决定（修正上轮「双轨」）**：
1. **检索侧**：`KnowledgeResolver` / `knowledge.search` 执行器**内部实现**由「本地 LIKE」换成「调 capm 三路召回」，**对外签名不变**——这是同一接口换实现，**不是双轨**（管理台在 capm 的 `apps/web`）。
2. **admin 写入侧**：10 个零调用路由**直接退役**（知识库建/改/发布归 capm 管理台）；留着即成影子权威。
3. **五表**：**随 admin 路由一同退役**（不留影子权威）。chunk/index 内容表本就占位；base/document/revision 不再保留。
4. **不保留表但要保留的三件事**：「索引就绪才发布」门的语义（**移到 capm 侧实现**，nexharness 只认 capm 的 ready 结果）；id 映射（运行时不需要——只认 capm 返回的 `document:revision:chunk` 引用）；租户隔离（capm `knowledge-search.access-filter` 已实现）。

**理由**：符合「项目不允许双轨实现」的工程原则——**capm 是唯一权威，nexharness 无影子权威**。详见 §7.1。

### D3 MCP 形态 —— ✅ 定稿（三位置口径）

三个位置分三句话：
- **入向（消费 capm 的 MCP 资产）**＝像技能一样同步 zip 包到本地，运行时不连 capm（落在 D1 的 A 类）；即 Phase 1B 的「tool/mcp 同步推广」。
- **出向（gateway 对 hosted runtime 暴露工具面）**＝**保持现有自有协议，不改 MCP**。自有协议比 MCP 多了 **invocation 级安全围栏**（MCP 无），是核心资产；改 MCP 是净增成本零收益。**唯一可选补充**：一份「自有协议 ↔ MCP 语义映射文档」（纯纸面，非第二套实现）；若按 YAGNI 也可不做，需要时再写。
- **registry（capm 做私有 MCP 注册中心）**＝capm 侧按官方格式（server.json + 反向 DNS 命名空间 + OpenAPI）做，nexharness 只当消费者。

**澄清（避免误解为冗余实现）**：只有「双协议端点并存」才是冗余实现，已明确**不采纳**；出向保持单一自有协议，MCP 仅为纸面预留。详见 §7.2。

### D4 自留边界 —— ✅ 定稿（原建议）

双判据 + **区分执法层与资产层**：执法层（`lib/capability` 的 apply-tool-call/catalog/schema 校验、harness-loop 五类 action executors、gateway 协议、skill runtime）自留本仓；资产层（具体工具/技能/MCP/知识内容）一律 capm 权威，用 source 字段标记边界（capm 来的 `source=capability_market`）。

### D5 候选记忆人审 —— ✅ 定稿（修正：默认自动沉淀，仅组织级人审）

**代码事实**：`evaluateMemoryPolicy` 规则明确——**敏感内容 → rejected**（销毁正文）；**organization 级作用域 → needs_review**（仅此一类进人审）；**其余全部 accepted（自动沉淀）**。故「海量记忆都要人审」的担忧不成立：**默认自动沉淀，只有「要上升为全组织共享」的记忆才需要管理员复核一次**。

**定稿**：维持现有策略不变（不加大人审负担）。自动沉淀产生的 Entry 非终局——支持「事后可撤销/纠正」兜底（发现沉淀错了能删/改，以撤销机制替代前置审批）；organization 级保留单次人审（共享给全公司的门槛）。

**待定**：organization 级记忆的**审核人/流程不在本阶段定**——标记为「待联调 auth-center 时确定」（审核权限大概率落入 auth-center 角色体系）。详见 §7.3。

### D6 compaction 策略 —— ✅ 定稿（原建议）

**代码事实**：分层淘汰已实现（`budget.ts` 的 FRAGMENT_PRIORITY_TIERS，预算不足时 TIER_SUMMARY/TIER_HISTORY 优先排除）；checkpoint 已有 summaryRef/summaryRedacted/summaryHash。缺的只是「用 LLM 生成摘要」这一步。

**决定**：手动优先（显式 /compact 类命令）；自动按阈值可开但**默认关闭**（成本红线 + per-thread 只能收紧的既有哲学）。分层淘汰做基底，不引入额外付费调用。

### D7 可视化编排 —— ✅ 定稿（不纳入阶段⑥）

**是什么**：FlowGram（字节）那类「拖拽节点画布 + 表单配置」的工作流搭建 UI，给非开发者配流程用；本质上与 harness 核心（代码定义的 Job 状态机）无关，是管理台产品面。

**决定**：不纳入。理由与用户判断一致——**harness 工程不需要可视化编排**。阶段⑥只做「DAG 的声明式表达 + 检查点语义文档化」（API/配置层）；画布若将来有明确内部受众，单独立项。

---

## 7.1 D2 详析：为什么是「退役」而不是「双轨」（2026-10-16 修正记录）

> 本节记录一次**结论反转**：初版建议「双轨过渡」（保留五表作绑定/状态），经用户质疑 + 二次代码核对后**推翻**，改判「检索侧换实现 + 写入侧与五表退役」。以下是核对过程与最终依据，保留以防反复。

### 第一步：核对消费方（推翻了「占位」的初判）

| 组件 | 真实消费方 | 性质 |
|---|---|---|
| `knowledge.search` 执行器（`platform-action-executors.ts`） | 运行时活跃（harness-loop 一级动作） | **真消费方**，接的是本地 LIKE 实现（半成品） |
| `KnowledgeResolver`（`source-resolvers.ts`） | 经 `buildDefaultResolvers()` 注册（与 RecentItems/Skill/WorkspaceMap/Memory 并列） | **真消费方**，同接本地 LIKE |
| `app/admin/api/knowledge-bases/*`（10 路由） | 全仓（含 nexharness-client 仓、scripts）**零调用方** | **无消费方** |
| `admin/api/memory-candidates/[candidateId]/resolve` | 同上，用户管理端零调用 | **无消费方** |

### 第二步：用户质疑（关键工程原则）

> 「如果是两份实现，那到时候会打架的啊或者 capm 就名存实亡了吧？而且正常来说项目是不允许双轨实现的。」
> 「我们项目缓存一份映射实际还是在 capm 那边？……那 capm 就名存实亡了。」

**质疑成立**：保留五表 = 保留一份影子权威，长期必然与 capm 分歧。项目红线本就禁止双轨/兼容/旧路径共存。

### 第三步：修正后的判定

**不采用双轨**，改为：
1. **检索侧**：`KnowledgeResolver` / `knowledge.search` **同接口换实现**（LIKE → capm 三路召回），签名不变——这是「换后端」，不是双轨。
2. **写入侧**：10 个零调用 admin 路由**退役**（知识库建/改/发布归 capm 管理台 `apps/web`）。
3. **五表**：**随之一并退役**，不留影子权威。
4. **要保留的三件东西不靠本地表实现**：
   - 「索引就绪才发布」安全门 → **移到 capm 侧**（它的索引它最清楚；nexharness 只认 capm 返回的 ready 结果，且保留「索引未就绪 → `unavailable` 不伪装 `empty`」的运行时语义）。
   - id 映射 → 运行时不需要（只认 capm 返回的 `document:revision:chunk` 引用，`source-resolvers.ts` 的 `sourceRefs` 已是此形式）。
   - 租户隔离 → capm 的 `knowledge-search.access-filter.service` 已实现。

### 结论

**退役**。收益：capm 成为唯一权威、无影子权威、符合「禁双轨」红线；代价与风险：需先确认 10 个 admin 路由确无外部消费者（已核对全仓 + client 仓 = 零），迁移与退役同批完成。

---

## 7.2 D3 详析：MCP 是什么、nexharness 该做什么

**MCP 是什么**：Anthropic 2024 年提出的开放协议，让 AI 应用用统一格式连接外部工具/数据（类比「AI 世界的 USB-C」）。已成行业标准（10k+ 服务器，捐给 Linux 基金会）。它规定三件事：怎么**描述**工具（schema）、怎么**调用**工具（tools/call）、怎么**发现**工具（tools/list）。

**关键澄清**：nexharness **不需要「变成 MCP」**。MCP 在这套架构里只出现在三个位置，各自结论不同：

### 位置一：入向 —— nexharness 消费 capm 里的 MCP 资产

capm 的 `capability_assets` 有 `assetType=mcp`。nexharness 要不要接？

**建议：接，方式与技能完全一样（同步 zip 包到本地）**。理由：MCP 资产和技能一样是「定义」，本地镜像后运行时不依赖 capm 在线——正好落在 D1 的 A 类。所以 **Phase 1B 的「tool/mcp 同步推广」就是这个**，没有新东西。

### 位置二：出向 —— nexharness 给 agent 暴露工具面

我们的 gateway（`tool-calls` + schema_hash + invocation 围栏）**要不要改成 MCP 协议**？

**建议：不改**。三个理由：① 我们自有协议比 MCP 多了 **invocation 级安全围栏**（MCP 没有），这是核心资产；② 改双端点要维护两套 wire，纯成本；③ 内部 hosted runtime 是我们自己的，不需要兼容外部生态。**但要做一件事**：写一份「自有协议 ↔ MCP 语义映射文档」（我们的 tool-calls ↔ MCP tools/call、schema_hash ↔ tools/list_changed），万一将来要对接外部 MCP 客户端，有现成对照表。

### 位置三：registry —— capm 作为私有 MCP 注册中心

官方的 MCP Registry（registry.modelcontextprotocol.io）**明确不支持私有服务器**，官方建议「自建私有 registry 并实现同一套 OpenAPI 接口」。capm 的 `knowledge-mcp` 域就是这个角色。

**建议：这是 capm 侧的活，nexharness 不用管**。nexharness 只是间接受益——将来 capm 的 MCP 资产能对接官方生态时，我们同步来的就能直接用。

**一句话总结 D3**：入向照搬技能同步（要做的活）、出向保持自有协议+写映射文档（不折腾）、registry 是 capm 的事（不操心）。

---

## 7.3 D5 详析：为什么记忆沉淀不需要人审（以及唯一例外）

**你的质疑完全正确**，而且代码本来就是按你的想法写的——是我上一轮没查到位，把预留给「组织级共享」的那一个人审关卡说成了普遍流程。

**`evaluateMemoryPolicy` 的实际规则**（`lib/context/memory-queries.ts`）：

| 情况 | 决策 | 要人审吗 |
|---|---|---|
| 内容含 Secret/Token/Cookie/私钥 | `rejected`（正文销毁、不回显） | 否，直接拒 |
| 作用域 = **organization**（全组织共享） | `needs_review` | **是（唯一例外）** |
| 其他所有情况（user / thread / agent 级） | `accepted` | **否，自动沉淀** |

所以你的直觉是对的：**日常记忆自动沉淀，不该烦用户**。真正需要把关的只有一种——「这条记忆要不要让全公司都看到」，这种一次性复核是合理的（共享门槛），而且量极小。

**本轮定稿（在你倾向的基础上再加固）**：
1. **默认全自动沉淀**（现状保持，不增大任何人的审核负担）；
2. **organization 级保留单次人审**（共享给全组织的门槛，防误共享）；
3. **新增事后兜底**：自动沉淀的记忆支持管理员「撤销/纠正」（发现沉淀错了能删能改）——**用「事后可撤销」替代「事前逐条审批」**，这才是不烦人又不失控的做法。

第 3 条是本轮新增项，属 Phase 2 范围。

---

## 8. 本轮评审新增待决点（E1–E3，2026-10-16）

D1–D7 已全部定稿（§7）。以下三项是本轮复核暴露的新缺口，**已由用户拍板定稿**。

### E1（P0，阻塞 Phase 1A）—— ✅ 定稿：E1-b（新增 `degraded` 语义）

**背景**：D1 定了「知识检索不可达时，只读检索可降级为『无知识上下文 + observation 标注』」。但代码核对发现 `KnowledgeResolver` 现有语义是「索引未就绪 → `unavailable`（不伪装 `empty`）」，而 `harness-loop` 执行器对 `denied`/`unavailable` 的处理是 **throw**。D1 想要「服务不可达可继续」，与现有「`unavailable` 即硬失败」冲突。

**定稿（E1-b）**：**新增独立状态/标注，不复活 `unavailable` 语义**。二者是两件事：
- `unavailable` = **索引未就绪**（真不可用）→ 保持现状，抛错（不伪装 empty 的不变量不动）；
- 新增 `degraded`（或等价标注）= **服务不可达**（capm 连不上）→ 只读检索可继续，observation 标注 `knowledge_unavailable`，agent 明确知道「没查到是因为服务不可达，不是知识库没有」。

需改：执行器分支（`platform-action-executors.ts`）+ `KnowledgeResolver` 返回态 + observation 语义。与 D1「必须区分『服务不可达』与『没有相关知识』」一致。**结论 → Phase 1A 实施项。**

### E2（P1）—— ✅ 定稿：退役前先核对 enterprise 分支

**背景**：D2 定稿要退役 `app/admin/api/knowledge-bases/*`（10 路由）。已核对全仓 + nexharness-client 仓零调用方，但 enterprise 分支未核对。

**定稿**：**退役前先在 enterprise 分支做一次 grep 核对**（属 Phase 1A 同批前置动作），避免破坏企业线（红线「企业线勿破坏」）。**结论 → Phase 1A 前置动作。**

### E3（P2）—— ✅ 定稿：**撤销「schema_hash 上移」**（一步到位，零迁移）

**背景**：原 B2「schema_hash 上移 capm 计算」经二次核对**推翻**——capm 侧**完全没有 schema_hash 概念**（全仓 grep 零匹配），它只有 `content_hash`（**包级**，`computePackageHash`）与 `toolManifest`。

**关键事实**：
| | nexharness | capability-market |
|---|---|---|
| schema_hash | `computeSchemaHash()`（`lib/capability/tool-queries.ts:218`） | **无** |
| 覆盖内容 | `{input, output, risk, **executionContract**, executionContractDigest}` 的 sha256 | — |
| 同类物 | — | `content_hash`（包级）+ `toolManifest` |
| 调用处 | 仅 1 处：创建本地 SchemaRevision（`tool-queries.ts:1152`） | — |
| gateway 校验 | 本地冻结 catalog + 本地 DB（`apply-tool-call.ts` 比对 `tool.schemaHash`） | 不参与 |

**定稿**：
1. **不上移**——`executionContract`（沙箱/执行绑定）是 nexharness 独有的**执行侧**概念，capm 没有。上移等于逼 capm 理解执行细节，反向耦合。
2. **原「双侧漂移误拒」风险不存在**——只有一侧在算，没有第二份。
3. **正确归属**：capm 管**定义 + 版本**（`content_hash` 作版本身份）；nexharness 管**执行侧冻结**（`schema_hash` 覆盖 executionContract）。各归其位。
4. **跨边界对齐**用 capm 的 `content_hash`（绑定记录已有 `remoteAssetId`/version），无需 schema_hash 跨仓。

**收益**：零迁移、零中间态（正是「一步到位」的本意），且比「上移」更干净。**结论：B2 撤销，Phase 1B 不含 hash 相关项。**

---

## 9. Phase 1A 接口契约补充定稿（2026-10-16，详见 07 §8）

Phase 1A 启动前的两端契约实测核对结论（三项用户拍板 + 一项新发现）：

- **D2-附1（ID 体系）**：capm 为 KB id 权威，**无需映射表**（两仓主键同格式）；nexharness 本地那批 LIKE 占位期 KB 数据迁入 capm 或清空重录。
- **D2-附2（鉴权）**：配**固定内部 token**（`NEX_CAPABILITY_MARKET_TOKEN`，与 skill 同步同一套）——**不跳过鉴权**（否则 capm `access-filter` 的租户过滤失效）；待联调 auth-center 时换真实用户身份透传。
- **D2-附3（字段）**：nexharness 热路径仅**必需 3 字段**（`chunkId`←`chunk_id`、`chunkHash`←`citation.content_hash`、`documentId`←`document_id`）——capm 全有；**`revisionId` 暂设非必填**（可空，待与 capm 讨论版本概念）；`documentKey`/`knowledgeBaseDisplayName`/`revisionHash` 无消费方，移除；`revisionPublishedAt` 用 `citation.updated_at` 兜底。
- **新发现 N1（已定稿）**：capm **目录端点已存在**（`GET /api/knowledge-bases`），但用 **`AdminTokenGuard`**，与检索 `POST /knowledge-search/hybrid` 的 **`PlatformTokenAuthGuard`** 是**两套鉴权**。**定稿：先给默认 token 让 Phase 1A 跑通，不为此纠结；待联调 auth-center 时由 capm 侧统一鉴权**（用户 2026-10-16 明确）。nexharness 对两类端点各配默认 token 值（可 env 覆盖），不引入适配层、不改 capm。
