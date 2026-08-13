# agentkit 会话与外部证据覆盖审计

本文是内部审查附件，用于回答两个问题：

1. agentkit 会话中已经确认和纠正的内容是否全部有落点。
2. 哪些内容来自后续外部研究，是否被错误伪装成用户早期决定。

## 1. 来源

### 1.1 主要会话

- Codex 项目：snow_harness。
- 自定义标题：agentkit。
- Thread ID：019f59ed-8084-7da2-aa93-1a8ea2cb2aab。
- 审计方式：直接读取原始会话记录中的用户消息、批注和被用户认可的回答，不以早期 docs/03-智能体 代替会话。

原始记录包含重复提问、continue、环境信息、只要求回答问题和要求暂不改文档等过程消息。它们被逐条读取，但不会伪装成产品需求。本文不使用“文件行数”或“聊天轮次数”替代语义覆盖。

### 1.2 后续确认

用户在外部产品与开源项目重审后确认：

> 改为会话与事件优先、Agent Loop 动态装配、执行环境负责强制边界、管理后台负责 AgentKit 式治理；通用 Run 产品层已撤回，Invocation/按需 Attempt、Temporal 和选择性 Checkpoint 只作为内部机制。

这个确认覆盖原 agentkit 会话中较早、偏传统执行平台的实现推导，但不覆盖原会话已经明确的产品语义，例如 Agent 唯一、Workspace 是默认位置、重试不复制用户消息、Credential 不放 Agent、员工端也要改造等。

## 2. 覆盖口径

每条实质内容分为：

| 类型 | 处理 |
|---|---|
| 用户明确确认 | 写入总方案、模块文档和决策台账 |
| 用户后续纠正 | 后一个决定覆盖前一个草案，旧内容进入“已撤回” |
| 用户明确暂缓 | 写入“待确认”，不伪装成已设计 |
| 外部研究后被用户确认 | 写入当前方案，同时在证据区标来源 |
| 助手单方面建议且未确认 | 不写成目标方案 |
| continue、状态询问、写作指令 | 只影响工作过程，不冒充产品需求 |

## 3. agentkit 会话主题覆盖

| 会话主题 | 用户最终意思 | 当前落点 |
|---|---|---|
| SnowHarness、capability-market、VeADK 分工 | SnowHarness 是平台；能力中心并入；VeADK 执行 | [总方案](./README.md)、[发布与 Runtime](./runtime-control-plane.md) |
| 员工端与后台 | 员工端是 Desktop + Web；两者都能处理云端任务，Desktop 额外连接本地资源；后台是 AgentKit 式治理 | [产品入口](./product-surfaces-and-admin.md) |
| Desktop 目标形态 | 不让员工在多个系统间手工搬数据；右侧面板可操作内部系统，有受控接口时直接调用，敏感提交由员工确认 | [总方案](./README.md)、[产品入口](./product-surfaces-and-admin.md) |
| 范围 | 员工端也要随 改，不是 V10 不动 | [总方案](./README.md)、[产品入口](./product-surfaces-and-admin.md) |
| Agent 与 Application | 火山所谓应用本质是 Agent；不新增 Application | [总方案](./README.md)、[决策台账](./decision-ledger.md) |
| 应用市场 | 内部不需要购买、评分、营销市场 | [产品入口](./product-surfaces-and-admin.md) |
| Agent 入口 | Agent 与 Skill 选择器在同一输入区 | [产品入口](./product-surfaces-and-admin.md) |
| Preview、部署、Git | Preview 属于 Harness；员工侧部署/Git 不做；Runtime 发布保留 | [总方案](./README.md)、[产品入口](./product-surfaces-and-admin.md) |
| Agent 默认装配 | Agent 可带模型、Skill、Tool、Knowledge，员工本轮可调整 | [Agent 与 Runtime](./agent-control-plane.md) |
| Agent 能力支持 | 不支持的动态能力在 UI 禁用并解释，后端复核 | [产品入口](./product-surfaces-and-admin.md)、[Agent 与 Runtime](./agent-control-plane.md) |
| 强制模型 | 管理员或任务策略可以强制模型 | [总方案](./README.md)、[Agent 与 Runtime](./agent-control-plane.md) |
| Agent 使用范围 | 默认全员，可按部门、组、角色、用户限制 | [产品入口](./product-surfaces-and-admin.md) |
| 测试范围 | 不增加测试中生命周期，收窄使用范围即可 | [产品入口](./product-surfaces-and-admin.md)、[决策台账](./decision-ledger.md) |
| 资源范围 | Agent 装配共享资源并开放给员工即构成使用授权，不机械求交部门范围 | [产品入口](./product-surfaces-and-admin.md) |
| CredentialMode | 从 Agent 删除，由 Connector 与当前用户身份处理 | [Skill、Tool 与安全](./capabilities-and-security.md) |
| AI 与 Tool 参数 | AI 选能力并封装业务参数；系统注入身份和 Credential | [Skill、Tool 与安全](./capabilities-and-security.md) |
| 可视化 Agent | 不做；使用 VeADK 代码和 agent.yaml，在本地或公司标准环境开发后部署到托管 Runtime | [Agent 与 Runtime](./agent-control-plane.md)、[发布与 Runtime](./runtime-control-plane.md) |
| 普通项目流程 | Agent 不再重复描述一套开发、测试、构建、部署 | [发布与 Runtime](./runtime-control-plane.md) |
| 托管与外部部署 | SnowHarness 统一入口；也支持标准外部 Runtime | [发布与 Runtime](./runtime-control-plane.md) |
| 公司 CI/CD | 最后对接公司接口，本方案不提前设计 | [决策台账](./decision-ledger.md) |
| 会话连续性 | 切换模型或 Agent 不丢历史 | [Agent 与 Runtime](./agent-control-plane.md) |
| 主 Agent | 后续重审后 Thread 保留主 Agent，变化显式交接 | [Agent 与 Runtime](./agent-control-plane.md) |
| Workspace 创建 | Thread 可选 Desktop、Cloud 或无 Workspace | [Agent 与 Runtime](./agent-control-plane.md) |
| Workspace 锁定 | 原会话确认它只是默认位置；后续重审允许显式切换 | [Agent 与 Runtime](./agent-control-plane.md) |
| 跨目录 | 用户明确要求的普通目录可以操作，不因离开 Workspace 弹窗 | [Agent 与 Runtime](./agent-control-plane.md)、[Skill、Tool 与安全](./capabilities-and-security.md) |
| 本地文件输出 | 处理本地文件时默认留在原位置，不强写 Cloud | [Agent 与 Runtime](./agent-control-plane.md) |
| 执行环境 | Desktop、Cloud、Remote、Sandbox 才是强制边界 | [Agent 与 Runtime](./agent-control-plane.md) |
| Thread/Turn/Run | 后续确认员工主模型为 Thread → Turn → Item，Event 独立记录变化；Invocation/Attempt 留在内部执行 | [总方案](./README.md)、[Agent 与 Runtime](./agent-control-plane.md)、[统一领域模型](./domain-model.md) |
| 重试 | 不复制用户消息；旧回答被替代 | [产品入口](./product-surfaces-and-admin.md)、[连续性](./conversations.md) |
| 已发生副作用后重试 | 复用已确认结果，不能重复发送或提交 | [连续性](./conversations.md) |
| 运行中输入 | 默认排队，可编辑、删除、排序和引导 | [产品入口](./product-surfaces-and-admin.md)、[连续性](./conversations.md) |
| 停止 | 只停止当前执行并暂停队列 | [连续性](./conversations.md) |
| Context 重要性 | 作为 Agent Loop 核心能力重写 | [上下文与 Memory](./context-memory-and-knowledge.md) |
| Context 组装位置 | Runtime 渐进组装，平台按需提供事实与检索 | [上下文与 Memory](./context-memory-and-knowledge.md) |
| 完整快照 | 后续确认不默认保存每次完整大包 | [上下文与 Memory](./context-memory-and-knowledge.md) |
| 长期 Memory | 原会话要求用户可跨 Agent；后续细化为只有通用偏好跨 Agent | [上下文与 Memory](./context-memory-and-knowledge.md) |
| Knowledge | 与 Memory 分开，内容保持当前 | [上下文与 Memory](./context-memory-and-knowledge.md) |
| 知识图谱 | Knowledge Base 内部检索结构 | [上下文与 Memory](./context-memory-and-knowledge.md) |
| Skill/Tool 本地化 | 产物缓存或预装，不每次远程下载执行 | [Skill、Tool 与安全](./capabilities-and-security.md) |
| auto/pinned | 原会话曾确认二选一；后续总方向撤回为普通交互通用模式 | [Skill、Tool 与安全](./capabilities-and-security.md)、[决策台账](./decision-ledger.md) |
| Skill 依赖 | 不要求静态依赖树，不用 AI 推断做门禁 | [Skill、Tool 与安全](./capabilities-and-security.md) |
| Tool Schema | AI 调用前读取，稳定边界为单次 ToolCall | [Skill、Tool 与安全](./capabilities-and-security.md) |
| 能力更新负担 | 普通更新自动；高风险变化集中审核和针对性评测 | [Skill、Tool 与安全](./capabilities-and-security.md)、[发布与评测](./runtime-control-plane.md) |
| MCP | 原会话要求先不做，仍列待确认 | [Skill、Tool 与安全](./capabilities-and-security.md)、[决策台账](./decision-ledger.md) |
| Tool 权限 | 按影响、数据去向、环境、可恢复性判断 | [Skill、Tool 与安全](./capabilities-and-security.md) |
| 登录与确认 | 都是 pause，但恢复原因不同 | [Skill、Tool 与安全](./capabilities-and-security.md) |
| Credential 使用 | 可信执行器可使用，模型和观测不拿原值 | [Skill、Tool 与安全](./capabilities-and-security.md) |
| 安全与质量 | 安全围栏和评测分开 | [Skill、Tool 与安全](./capabilities-and-security.md)、[发布与评测](./runtime-control-plane.md) |
| Temporal | 原会话采纳可靠执行；后续重审降为长任务内部机制 | [连续性](./conversations.md) |
| unknown effect | 超时后核对，不盲目重试副作用 | [连续性](./conversations.md) |
| 多智能体 | 后续重审改为 Child Thread 为默认，另支持 Workflow、Agent-as-Tool、A2A | [连续性](./conversations.md) |
| 子智能体上下文 | 独立上下文，结构化 Handoff | [连续性](./conversations.md) |
| 调度与容量 | 交互队列与执行队列分开，Slot、预算和公平调度 | [连续性](./conversations.md)、[发布与评测](./runtime-control-plane.md) |
| 观测内容 | 后台要看到完整路径；后续确认默认结构、内容按策略 | [发布与评测](./runtime-control-plane.md) |
| Trace 粒度 | Invocation 一个结构化 Trace，Turn/Thread/任务聚合 | [发布与评测](./runtime-control-plane.md) |
| 评测 | 同时建设，复用真实 Runtime 和测试环境 | [发布与评测](./runtime-control-plane.md) |
| 管理后台 | AgentKit 式治理分组 | [产品入口](./product-surfaces-and-admin.md) |

### 3.1 后续授权收敛的覆盖

以下内容来自用户在本会话后续明确提出的“补齐并推进到可直接实施规格”，不是原 agentkit 会话逐项决定。具体技术规则由本轮结合已确认主轴和当前外部证据推导。

| 收敛主题 | 本轮形成的边界 | 当前落点 |
|---|---|---|
| 能力发现 | 员工选择器与 Agent Loop 都需要动态、受权限过滤的目录；搜索候选不等于实际使用 | [能力与协作 API](./capability-and-collaboration-api.md) |
| 多智能体命令 | Child Thread 需要创建、查询结果、取消和 Handoff 的明确边界 | [能力与协作 API](./capability-and-collaboration-api.md) |
| Memory 写入 | Runtime 不能把模型判断直接变成长期事实，只能提交 Candidate | [Memory 与 Job API](./memory-and-job-api.md) |
| Job 控制 | cancel 请求与终态分开；retry 创建 replacement Job | [Memory 与 Job API](./memory-and-job-api.md) |
| 生产运维与安全 | Event 背压/隔离、多设备执行所有权、供应链、action scope、保留和删除需要进入实施规格 | [生产运维、安全与保留](./security.md) |
| 机器协议 | API、Event、错误码和 Runtime Adapter 需要可自动校验，不能只依赖 Markdown | [机器契约](./contracts-and-conformance.md) |
| 最终数据/API | 用户先要求稳定方案边界，随后确认正式收敛；现已形成统一领域、核心表、分卷 API、生产约束和机器契约 | [统一领域模型](./domain-model.md)、[核心数据模型](./persistence.md)、[机器契约](./contracts-and-conformance.md) |

## 4. 用户批注纠正覆盖

| 早期或被批注内容 | 用户纠正 / 后续确认 | 当前处理 |
|---|---|---|
| 员工执行、管理员只看报表 | 员工端是 Desktop + Web；后台治理 Agent、部署、Skill、Tool 等 | 三端在产品文档明确分工 |
| auto 自动跟随最新但生成 DeploymentRevision | 用户质疑大量 Agent 的负担；后续确认动态装配 | 删除普通更新生成 Agent Revision |
| 删除自动跟随最新大版本 | 用户问删除后怎样；后续重审明确撤回 | 普通交互读取当前生效能力并记录 hash |
| Skill 更新会导致 Agent 不可复现 | 用户指出 Skill 文本和 Tool Schema 可由 AI 理解 | 稳定边界改成实际模型决策和单次 ToolCall |
| 所有 Agent 更新后统一回归 | 用户指出负担过重 | 平台做风险差异，只有高风险变化针对性审核/评测 |
| Skill 依赖树要静态校验 | 用户认为作者不会可靠维护 | 不维护静态树，运行时保护和事实记录 |
| 知识图谱遗漏 | 用户指出能力中心已有 | 明确放在 Knowledge Base 内部 |
| Workspace 锁定后不能操作别处 | 用户强调它只是默认位置 | 显式位置优先，Environment 才是强制边界 |
| Cloud Thread 处理本地文件后输出到 Cloud | 用户明确应在本地处理和输出 | 位置优先级写入 Agent/Workspace 模块 |
| 重试创建新消息 | 用户明确重试不能堆积“你好” | UserMessage 唯一，回答分支替代 |
| 运行中输入只有排队 | 用户要求编辑、删除、排序和引导 | PendingInput 与 steer 语义完整保留 |
| V10 做观测评测 | 用户指出新方案应叫 | 全目录统一为 |
| SnowHarness 含义不清 | 用户追问具体指什么 | 文档区分 Platform、Runtime、Desktop 和 Gateway |
| V10 员工端、只加后台 | 用户明确员工端也需改造 | 总方案和产品文档都纳入 |
| 先做最终表/API | 用户当时要求先整合和优化方案，稳定后又明确说“确认，开始正式收敛” | 先前暂缓记录保留为过程；当前正式定案领域、数据和 API 边界 |
| 03-智能体 是主要依据 | 用户纠正它只是早期方案 | 仅以 agentkit 会话和后续确认作为主依据 |
| 方案拆成多文件可能遗漏 | 用户要求总方案可独立读且证明覆盖 | 00 可独立阅读，本文逐主题映射 |

## 5. 外部证据

这些来源用于审视设计，不替代用户决定。

| 来源 | 可验证内容 | 借鉴 | 没有照搬 |
|---|---|---|---|
| [Codex App Server](https://github.com/openai/codex/blob/main/codex-rs/app-server/README.md) | Thread、Turn、Item；resume、fork、steer、interrupt；Goal；parentThreadId/ancestorThreadId 子 Thread；skills/MCP/Environment 查询 | 会话与事件主模型、连续性、子任务和能力/环境分离 | 没照搬协议字段或实验功能 |
| [Claude Code 工作原理](https://code.claude.com/docs/en/how-claude-code-works) | Agent Loop、按需上下文、行动与验证 | 渐进 Context Assembly | 没照搬 Claude 专用工具和权限配置 |
| [Kimi Code Sessions](https://github.com/MoonshotAI/kimi-code/blob/main/docs/zh/guides/sessions.md) | Session 恢复、分叉和压缩 | 持久事件与会话连续性 | 没照搬存储格式 |
| [Kimi Code Goals](https://github.com/MoonshotAI/kimi-code/blob/main/docs/zh/guides/goals.md) | Goal 是可选工作模式 | 普通问答不强制 Goal | 没把 Goal 变成每个 Turn 必需对象 |
| [Kimi Code Agents](https://github.com/MoonshotAI/kimi-code/blob/main/docs/zh/customization/agents.md) | 子 Agent 独立上下文 | Child Thread 与结构化交接 | 没把角色文件直接当 SnowHarness Agent |
| [Kimi Code](https://github.com/MoonshotAI/kimi-code) | Skill/MCP/数据源安装展示 trust level，Subagent 使用隔离上下文，ACP 连接客户端与 Agent | 能力信任、独立子任务和客户端协议分开 | 没照搬插件市场或本地存储实现 |
| [Qoder Cloud Agents](https://docs.qoder.com/cloud-agents/overview) | Agent、Environment、Session | 分离 Agent、会话与环境 | 没照搬云产品层级 |
| [Qoder Events Stream](https://docs.qoder.com/cloud-agents/events-stream) | 事件流表达状态和权限 | Event 支撑 UI 与恢复 | 没照搬事件名称 |
| [Claude Agent SDK Sessions](https://code.claude.com/docs/en/agent-sdk/sessions) | Session 恢复对话但不恢复文件系统 | Thread 与 FilesystemCheckpoint 分离 | 没照搬 Session 存储格式 |
| [VeADK Runner](https://github.com/volcengine/veadk-python/blob/main/docs/content/docs/framework/runner.mdx) | app/user/session 隔离并产生 Event | Runtime Adapter 映射身份、会话与 Event | 没让 VeADK 直写平台数据表 |
| [AgentKit Harness](https://github.com/volcengine/agentkit-sdk-python/blob/main/docs/content/2.agentkit-cli/5.harness.md) | Agent 默认装配与调用时覆盖 | 管理和执行分离、动态装配 | 没保留传统完整 Manifest 主轴 |
| [MCP Tools 规范](https://modelcontextprotocol.io/specification/2025-11-25/server/tools) | tools/list、JSON Schema、list_changed | Tool 调用前刷新，单次调用稳定 | 不代表 已确认建设 MCP 产品 |
| [Qwen Code](https://github.com/QwenLM/qwen-code) | Skills、Subagents、Teams、MCP、自动 Memory，以及 daemon 多客户端共享会话 | 能力发现、独立子任务、多客户端和执行所有权分开 | 没照搬其进程和存储实现 |
| [OpenHands](https://github.com/All-Hands-AI/OpenHands) | UI、Agent Server 与多种执行后端 | Desktop/Web 共平台、Environment 分离 | 没照搬部署实现 |
| [OpenCode](https://github.com/anomalyco/opencode) | 持久 SessionEvent 与 SessionMessage 投影并存，高频 delta 可只实时传输 | Event 账本与 Item 当前投影并用 | 没照搬表结构和事件名 |
| [LangGraph Durable Execution](https://docs.langchain.com/oss/python/langgraph/durable-execution) | Checkpoint 与持久执行 | 长任务可靠机制 | 没把图节点变成产品主对象 |
| [Letta Memory](https://docs.letta.com/guides/agents/memory) | 多层 Memory 与按需访问 | Memory 作用域和挂载 | 没照搬其数据模型 |
| [Langfuse Data Model](https://langfuse.com/docs/observability/data-model) | Session、Trace、Observation | Thread 聚合 Turn Trace | 没让 Trace 取代业务 Event |

## 6. 外部证据推导边界

### 6.1 可以写入目标方案

用户已经确认的新总方向中明确采用的内容：

- Thread/Turn/Item 员工主模型，Event 独立记录变化。
- Agent Loop 渐进上下文和动态能力。
- Execution Environment 强制边界。
- Child Thread 为默认多智能体会话单位。
- Invocation、按需 Attempt、Temporal 和选择性 Checkpoint 是内部机制；每次模型调用完整快照已撤回。
- Trace 默认结构化、内容按策略。

### 6.2 不能伪装成用户决定

- 外部项目具体表名、字段和 API；当前字段与 API 是本轮结合项目现状后的正式设计，不冒充外部原样复制。
- 某个产品的 UI 布局。
- 尚未讨论的公司 CI/CD 接口。
- MCP 独立产品是否进入 。
- 具体数据库、消息队列、Trace Store 和 Memory Provider 选型。
- 组织角色的最终权限粒度。

## 7. 文档联动矩阵

| 核心决定 | 00 | 01 | 02 | 03 | 04 | 05 | 06 | 07 | 09 | 10 | 11 |
|---|---:|---:|---:|---:|---:|---:|---:|---:|---:|---:|---:|
| 三端与管理后台 | ✓ | ✓ |  |  |  |  | ✓ | ✓ | ✓ |  | ✓ |
| Agent / Revision | ✓ | ✓ | ✓ |  | ✓ |  | ✓ | ✓ | ✓ | ✓ | ✓ |
| Thread / Turn / Item / Event | ✓ | ✓ | ✓ | ✓ |  | ✓ | ✓ | ✓ | ✓ | ✓ | ✓ |
| Workspace / Environment | ✓ | ✓ | ✓ | ✓ | ✓ | ✓ | ✓ | ✓ | ✓ | ✓ | ✓ |
| Context / Memory / Knowledge | ✓ |  | ✓ | ✓ | ✓ | ✓ | ✓ | ✓ | ✓ | ✓ | ✓ |
| Skill / Tool 动态更新 | ✓ | ✓ | ✓ | ✓ | ✓ |  | ✓ | ✓ | ✓ | ✓ | ✓ |
| 权限 / Credential / 安全 | ✓ | ✓ | ✓ | ✓ | ✓ | ✓ | ✓ | ✓ | ✓ | ✓ | ✓ |
| 恢复 / 重试 / 多智能体 | ✓ | ✓ | ✓ | ✓ | ✓ | ✓ | ✓ | ✓ | ✓ | ✓ | ✓ |
| 发布 / Runtime | ✓ | ✓ | ✓ |  | ✓ | ✓ | ✓ | ✓ | ✓ | ✓ | ✓ |
| Trace / 评测 / 成本 / 容量 | ✓ | ✓ | ✓ | ✓ | ✓ | ✓ | ✓ | ✓ | ✓ | ✓ | ✓ |
| 领域 / 数据 / API | ✓ |  | ✓ |  | ✓ | ✓ | ✓ | ✓ | ✓ | ✓ | ✓ |
| 待确认与已撤回 | ✓ |  |  |  | ✓ |  |  | ✓ | ✓ | ✓ | ✓ |

### 7.1 本次实施规格联动

| 新增边界 | 09 领域 | 10 数据 | 12 能力协作 | 13 Memory/Job | 14 生产治理 | 15 机器契约 |
|---|---:|---:|---:|---:|---:|---:|
| Capability Catalog / Schema refresh | ✓ | ✓ | ✓ |  |  | ✓ |
| Child Thread 命令 / Handoff | ✓ | ✓ | ✓ |  | ✓ | ✓ |
| MemoryCandidate / ContextCheckpoint | ✓ | ✓ |  | ✓ |  | ✓ |
| Job cancel / replacement retry | ✓ | ✓ |  | ✓ | ✓ | ✓ |
| Event checkpoint / quarantine / backpressure | ✓ | ✓ |  |  | ✓ | ✓ |
| execution ownership / 环境变更 | ✓ | ✓ |  |  | ✓ | ✓ |
| 制品证明 / action scope | ✓ | ✓ |  |  | ✓ | ✓ |
| Retention / Legal Hold / Deletion | ✓ | ✓ |  |  | ✓ | ✓ |

## 8. 完整性结论

当前 不是把会话原文压缩成几百行摘要。覆盖审计确认了以下关系：

- 每个已识别实质主题都有正文落点。
- 每个用户关键纠正都有当前处理和证据引用。
- 后续总方向明确覆盖早期传统执行平台推导。
- MCP 产品化、公司 CI/CD 实际接口、组织系统字段、具体保留天数和当地合规字段仍明确留在待确认；删除流程、权限动作、领域模型、核心表、分卷 API/Event 和机器契约已经收敛。
- 外部参考与用户决定分开记录。
- 00 总方案可以独立阅读，模块文档补足细节。

后续若修改任一核心决定，必须同时更新对应模块、[决策台账](./decision-ledger.md)、[统一领域模型](./domain-model.md)、[核心数据模型](./persistence.md)、11—14 号 API/生产分卷、[机器契约](./contracts-and-conformance.md) 和本覆盖审计，不能只改一处。
