# SnowHarness 架构

> 本文描述 SnowHarness 当前长期架构：会话与事件优先、Agent Loop 动态装配、执行环境强制边界、管理后台负责 Agent 治理。历史方案只用于追溯决定，不作为实现依据。

## 1. 方案结论

SnowHarness 是公司内部统一智能体平台，由三个产品入口和一套平台能力组成：

| 入口 | 使用者 | 主要职责 |
|---|---|---|
| 员工 Desktop | 员工 | 具备员工 Web 的全部云端任务能力，并连接本地项目、文件、浏览器登录态、本机应用和本地执行 |
| 员工 Web | 员工 | 使用 Agent 处理云端 Workspace、知识和业务系统任务，可与 Desktop 连续处理同一任务 |
| 管理后台 | 管理员、Agent 负责人、安全与运营人员 | 管理 Agent、部署、Runtime、Skill、Tool、知识、连接、权限、观测、评测、成本和容量 |

三端共用 Agent、Thread、身份、策略和事件事实。Desktop 与 Web 不是两个会话系统，管理后台也不是独立于 SnowHarness 的另一套 AgentKit。

SnowHarness 的产品主轴是：

~~~mermaid
flowchart TB
  Desktop["员工 Desktop<br/>云端任务 + 本地资源与系统操作"]
  Web["员工 Web<br/>云端任务与跨设备跟进"]
  Admin["管理后台"]

  Desktop --> Thread
  Web --> Thread
  Thread["Thread 会话<br/>默认 Workspace、连续历史"]
  Thread --> Goal["Goal 可选目标"]
  Thread --> Turn["Turn 正式交互"]
  Turn --> Item["Item 内容投影"]
  Turn --> Event["Event 有序变化记录"]
  Event --> Item
  Turn --> Loop["Agent Loop<br/>理解 → 获取上下文 → 行动 → 验证"]
  Loop --> Context["按需上下文"]
  Loop --> Capability["Skill / Tool / 子 Agent"]
  Loop --> Environment["Desktop / Cloud / Remote / Sandbox"]
  Loop --> Child["Child Thread"]

  Admin --> Control["Control Plane 控制面"]
  Control --> AgentAdmin["Agent / 部署 / Runtime / 能力 / 权限 / 凭证"]
  Control --> Projection["Trace / 评测 / 审计 / 成本"]
  Event --> Projection
~~~

员工端看到会话、工作过程、审批、产物和子智能体；每次实际 Agent 执行都有内部 Invocation，只有基础设施重试才增加 Attempt，Temporal Workflow 只服务长任务。这些对象不进入普通员工导航。

## 2. 范围

包含：

- 员工 Desktop 与员工 Web 对 Agent、事件流、运行中输入、授权等待、恢复和子智能体的支持。
- Agent 代码型定义、发布、部署、Runtime 和使用范围。
- capability-market 并入 SnowHarness 后的统一能力与知识治理入口。
- Thread、Goal、Turn、Item、Event 和 Agent Loop。
- 渐进式上下文、压缩、Memory 作用域、Knowledge Base 与知识图谱。
- Skill、Tool、连接、权限、凭证和副作用治理。
- Desktop、Cloud、Remote 与 Sandbox 执行环境。
- 恢复、分叉、引导、中断、幂等、子智能体与长任务可靠执行。
- 结构化 Trace、评测、审计、成本、容量和管理后台。
- 能力发现、Child Thread 命令、Memory/Job 写入边界和机器可读协议。
- Event 投影与背压、多设备执行所有权、制品供应链、保留、Legal Hold 和可证明删除。

不新增：

- Application、ApplicationInstance、SolutionPackage 或应用市场。内部可运行对象只有 Agent。
- Team、协作应用等第二套多智能体资产。
- 可视化 Agent 业务编排器。Agent 继续使用 VeADK 代码或 agent.yaml 表达。
- 与普通项目重复的开发流程。Agent 发布接入公司项目构建和部署体系。
- 一张统一所有对象生命周期的万能资产表。
- 为普通聊天强制创建 Job、Run、Goal、完整 Context Snapshot 或 Temporal Workflow。
- 纯事件溯源或一张表承载所有对象。使用关系状态、不可变修订、仅追加 Event 和可重建读模型组合。

MCP 在 agentkit 会话中被明确暂缓。只保证 Tool Gateway、动态工具发现和安全边界不排斥标准 MCP；是否建设独立 MCP 资产、菜单、连接和运营能力仍列为待确认，不在本文伪装成已实施决定。

## 3. 产品原则

### 3.1 一个 SnowHarness，三个入口

同一个 Thread 可以在 Web 或 Desktop 处理云端任务，也可以在两个入口之间继续。Desktop 在相同云端能力上增加本地项目、文件、浏览器登录态、本机应用和本地执行；真正依赖本地资源的动作由 Desktop 执行。管理后台从相同事件与 Trace 查看事实。

业务例子：员工在 Web 创建“月度报表”会话，回到办公室后在 Desktop 附加本地 Excel。会话历史和已确认约束不变，读取 Excel 的 ToolCall 路由到 Desktop。

Desktop 的目标不是让员工换一个地方手工操作系统，而是成为任务操作台。Agent 可以在右侧面板打开已登录的内部系统，帮助员工查询、填写和提交；目标系统提供受控接口时，优先直接调用接口，不要求打开页面。涉及发送、提交、付款、删除等高影响操作时，平台必须展示具体影响并等待员工确认，执行结果写回同一 Thread。

### 3.2 Agent 是可治理、可调用的智能体资产

SnowHarness 始终是 Harness 执行与编排主体，即使 Agent 目录为空也能创建 Thread、接纳 Turn 并执行。Agent 是可治理、可调用的一类智能体资产，不是唯一可运行资产，也不是 Thread 或基础 Harness 执行存在的前置条件。Agent 保存稳定身份、负责人、基础指令、默认能力、运行策略、允许委派范围和当前发布信息。所谓“应用”只可以是员工界面的产品称呼，底层不再创建 Application。

业务例子：“合同审查”在管理员后台、员工目录、部署和观测中始终是同一个 Agent，不再先安装应用实例再映射到 Agent。

### 3.3 Agent 自身版本与外部能力更新分开

以下变化产生新的 Agent Revision：

- Agent 指令、代码或 agent.yaml 变化。
- 默认模型策略、权限要求或允许委派范围变化。
- Agent 自身启动参数或不可变制品变化。

RuntimeRevision 和 DeploymentRoute 独立发布；它们与 AgentRevision 在新 Invocation 启动时组合，不因为 Runtime 调整重写 AgentRevision。

普通 Skill 文本、Tool 描述、Tool Schema 或知识内容更新，不自动制造一批 Agent Revision。平台在实际使用时解析当前生效内容，并记录内容 hash、Schema hash、来源和权限结果。

业务例子：30 个 Agent 都会使用“公司写作规范”Skill。规范文字更新后，新决策点按需加载新内容，不要求 30 个 Agent 分别发布；历史 Trace 仍能指出当时读取的具体 hash。

### 3.4 智能决策与确定性边界分工

LLM 负责：

- 理解用户意图。
- 决定是否加载 Skill、知识、Memory 或文件。
- 从已提供的 Tool 中选择能力。
- 根据当前 Schema 生成业务参数。
- 缺少信息时继续查找或向用户询问。
- 根据结果决定下一步并验证完成情况。

平台负责：

- 身份、租户、权限和数据边界。
- Tool 与执行环境暴露。
- Credential 选择和注入。
- 高风险副作用审批。
- 文件、网络、Secret 和系统访问的强制隔离。
- 恢复、审计、成本和企业策略。

业务例子：AI 可以决定调用“查询报销单”并填写日期范围，但不能自行选择数据库账号、伪造 userId 或把 OAuth Token 放入参数。

## 4. 核心对象

| 对象 | 作用 | 不负责什么 |
|---|---|---|
| Agent | 可复用的智能体定义和主身份 | 不保存每次实际 Tool Schema 和全部上下文 |
| Agent Revision | Agent 自身可发布变化的不可变修订 | 不跟随普通 Skill/Tool 更新批量生成 |
| Thread | 连续会话、默认 Workspace 和历史容器 | 不保存主 Agent，不锁死模型、能力内容或执行节点 |
| Goal | 有明确终点的持续目标，可选 | 普通问答不强制创建 |
| Turn | 一次进入 Thread 时间线的正式输入或触发周期 | 不保存单一 Revision/模型/环境/费用执行事实 |
| Item | 消息、计划、Tool、审批、产物和错误的当前内容投影 | 不记录每一次状态变化和高频遥测 |
| Event | Thread 内有序、仅追加的变化记录 | 不替代 Item 查询模型，不永久保存每个 Token delta |
| Agent Loop | 理解、取上下文、行动、验证和继续决策 | 不拥有权限与 Secret |
| Execution Environment | Desktop、Cloud、Remote、Sandbox 的强制执行边界 | 不等同于 Workspace |
| Workspace | 用户可见、可切换的默认工作位置 | 不是唯一文件访问范围 |
| Child Thread | 子智能体的独立上下文和事件状态 | 不把全部中间内容塞回父 Thread |
| Trace | 以 Invocation 为根的结构化观测数据，按 Turn/Thread 或 Job 聚合 | 不决定业务状态 |
| Invocation | 一次实际 Agent Loop 执行，属于 Turn 或 Job | 不成为员工端导航层级 |
| Attempt | 整个 Invocation 被基础设施重新调度的记录 | 不代表模型 Span、ToolCall 或 Agent Loop 每一步 |
| Job | 定时、批量、无人值守、部署、评测或知识构建任务 | 不伪装成员工 Turn |
| MemoryCandidate | Runtime 提出的可复用记忆候选 | 不直接成为长期 MemoryEntry |
| ProjectionCheckpoint | Event 消费者已完成的流内位置 | 不允许在投影失败前移 |
| DeletionRequest | 受保留策略与 Legal Hold 约束的数据删除命令 | 不等同于立即物理删除 |

### 4.1 Thread 与 Agent 解耦

Thread 是连续工作容器，不保存主 Agent 身份，也不要求先有 Agent 才能创建（专题 01 已删除 `primaryAgentId`）。Agent 是 Harness 可调用资产，与 Thread 从"存在性强绑定"改为"调用时可组合"。用户在某次 Turn/Invocation 偏好某 Agent、Agent 交接（handoff）与调用规划的语义由后续 Agent 调用专题定义，专题 01 不在 Thread 上伪造主 Agent 事实。调用辅助 Agent 通常创建 Child Thread。

业务例子：用户在财务助手会话中让风险审核 Agent检查一份报表，系统创建 Child Thread；财务助手仍负责最终回答。用户明确选择“接下来由风险审核助手负责”时的交接语义，由后续 Agent 调用专题定义。

### 4.2 Item 与 Event 分开

Item 保存员工可查询、可展示或可进入模型上下文的当前内容，包括：

- 用户消息、Agent 正式消息和公开进度。
- 计划、Tool 请求/结果、用户操作请求、Artifact 和 Child Thread 结果。
- 员工可理解的错误和配置变化摘要。

Event 记录这些内容和会话状态如何变化，包括 Turn、Item、ToolCall、授权、Workspace、引导、中断、恢复、分叉和交接。Event 先持久化再推送，客户端按 Thread sequence 断点续读；Token delta、心跳和高频日志默认走临时流，完成时归并为持久 Item 和 Event。

业务例子：Agent 流式生成回答时，Desktop 接收临时 delta；生成完成后平台写一个 `agent_message` Item 和一个 `item.completed` Event，而不是永久保存几千条 Token Event。

## 5. 端到端运行

~~~mermaid
sequenceDiagram
  participant U as 员工
  participant C as Desktop / Web
  participant P as SnowHarness Platform
  participant L as Agent Loop
  participant E as Execution Environment
  participant T as Tool / Knowledge

  U->>C: 发送任务
  C->>P: 创建 Turn
  P-->>C: 持久化 turn.accepted
  P->>P: 解析 Route 并创建 Invocation / ExecutionBinding
  P-->>C: 持久化 turn.started / invocation.started
  P->>L: 当前 Agent 约束（若有） + 当前策略 + 会话索引
  L->>L: 理解任务并判断缺少什么
  L->>P: 按需读取历史、Memory、知识或 Skill
  L->>T: 获取当前 Tool Schema
  L->>P: 提交 ToolCall
  P->>P: 权限、凭证和副作用判断
  P->>E: 在 Desktop / Cloud / Sandbox 执行
  E-->>P: 结果与实际影响
  P-->>L: ToolResult
  L->>L: 验证结果并决定继续或完成
  L-->>P: 正式回答
  P-->>C: 事件流与完成状态
~~~

平台在执行中自动产生本次实际执行记录，不要求管理员维护一份手工 Run Manifest。它是 `Invocation + ExecutionBinding + CapabilityUse + ToolCall/Effect + Permission + ThreadEvent/JobEvent + Trace` 的只读聚合，包含 Agent/Runtime Revision、模型、实际 Skill 内容 hash、Tool Schema hash、Knowledge/Memory 来源、环境、权限与 Credential 引用、成本和结果。

### 5.1 能力稳定边界

- Skill：默认读取当前生效内容；同一次模型决策已经装入的内容不会被中途替换。
- Tool：每次调用前使用当前 Schema；调用开始后，该调用使用的 Schema 与权限结果固定。
- 工具列表变化：在下一次模型决策前刷新，不影响已经开始的 ToolCall。
- Agent Revision：每个 Invocation 启动后 ExecutionBinding 不变；同一 Turn 的等待恢复沿用原 Binding，显式 Regenerate 或下一 Turn 的新 Invocation 可以采用当前 Route。
- 合规、定时或无人值守任务：可以显式固定 Agent Revision 和能力版本，但不是普通交互默认行为。

业务例子：ERP Tool 在对话进行中新增 department 参数。已发出的查询继续按旧 Schema 完成；下一次模型决策刷新 Schema，AI 会补齐部门，缺少时先查询用户资料或询问用户。

## 6. Workspace 与执行环境

Workspace 是默认搜索目录、相对路径基准、Bash 工作目录和默认产物位置。它可见、可显式切换，也可以挂载额外目录或文件。Workspace 变化必须成为事件，不做隐式迁移或双向同步。

Execution Environment 才负责强制边界：

| 环境 | 适用内容 | 强制边界 |
|---|---|---|
| Desktop | 本地文件、浏览器、本地命令和 Git | 当前用户授权、平台策略、敏感位置、网络和 Secret |
| Cloud | 云端 Workspace、长任务和共享服务 | 租户隔离、容器权限、网络出口和 Credential Gateway |
| Remote | 标准外部 Agent 或远程执行器 | 协议能力、身份、网络区和可观测范围 |
| Sandbox | Agent 临时生成的不可信代码 | 临时文件、CPU/内存/时长、网络和 Secret 全部受限 |

操作系统用户能够读取某个路径，只是基础条件，不表示 Agent 自动获得访问权。平台还要结合用户意图、数据敏感性、环境策略和操作影响。

业务例子：当前 Workspace 是 snow_harness，用户明确要求同时读取 skills 目录。平台可把 skills 作为本次任务的额外位置，不必切换主 Workspace；但读取 SSH 私钥仍被阻止，批量删除另一个工程仍需确认。

## 7. 上下文、Memory 与 Knowledge

上下文在 Agent Loop 中渐进组装：

1. 先提供平台规则、Agent 指令、当前用户消息、已确认约束和会话索引。
2. 根据任务查看最近对话、文件地图、Skill 摘要、Knowledge 目录和 Memory 索引。
3. 只在需要时加载正文、Tool 定义、文件片段、知识证据或记忆。
4. Tool 返回后更新当前工作状态，再进行下一次模型决策。
5. 长会话通过可追溯压缩保留目标、约束、决定、状态和原始事件引用。

Trace 默认记录来源、hash、Token、选择原因和成本；完整上下文正文是否保存由租户、环境、数据分类和诊断策略决定，不默认复制一份 full_redacted 大包。

Memory 按作用域管理：

| 作用域 | 内容例子 | 默认共享 |
|---|---|---|
| Thread | 当前对话、临时决定、未完成事项 | 仅当前 Thread |
| Project / Workspace | 技术栈、项目约定、任务状态 | 挂载同一项目的 Agent |
| User Preference | 默认中文、报表币种偏好 | 可跨 Agent |
| Agent-specific | 某 Agent 的业务偏好或长期协作习惯 | 仅该 Agent |
| Organization | 企业制度、策略和公共事实 | 按组织权限 |

密码、Token、验证码等不进入 Memory。平台指令、安全策略和管理员规则也不是“学到的记忆”，不能被自动更新覆盖。

Agent/Runtime 只能提交带来源、Scope、hash 和敏感性提示的 MemoryCandidate。平台 Memory Policy 校验后才能创建或更新 MemoryEntry；Organization Scope 必须由有权主体复核。Context Checkpoint 只保存来源范围、压缩摘要和 hash，不把摘要自动写成 Memory，也不删除原始 Item/Event。

Knowledge Base 独立于 Memory。知识图谱是 Knowledge Base 内部的实体、关系和证据索引，与全文和向量检索共同工作，Agent 绑定 Knowledge Base，不单独绑定知识图谱。

## 8. Skill、Tool 与安全

### 8.1 Skill

Skill 是可发现、可按需读取的指令与资源包。平台管理身份、所有者、可见范围、当前生效内容、来源和 hash，不要求作者维护静态 Skill 依赖树，也不让 AI 推断依赖作为发布门禁。

Skill 需要另一个 Skill 时可在运行中发现和加载；平台限制嵌套深度、调用次数、循环和预算，并从实际事件形成使用关系。

员工选择器和 Agent Loop 共用受权限过滤的能力目录。目录搜索只表示候选；Skill 内容真正加载或 Tool Schema 真正读取时才写 CapabilityUse。目录 revision 只用于缓存失效，不把所有候选固定进 Invocation。

### 8.2 Tool

Tool 必须提供机器可读 Schema、执行器、权限与风险元数据。AI 根据 Schema 封装业务参数；系统注入 userId、tenantId、连接、Credential 和 Trace 等基础参数。

普通描述或参数结构变化可以自动生效。只有变化扩大权限或风险时进入集中审核，例如：

- 只读变成写入。
- 新增外网或新数据目的地。
- 要求新的 Credential。
- 扩大文件、数据库或业务系统范围。
- 新增发送、付款、删除或其他不可逆副作用。

审核由平台差异检测集中触发，只通知能力负责人或安全管理员，不要求所有绑定 Agent 的负责人逐个重发和回归。

### 8.3 安全结果

~~~text
allow  直接执行，可附加观察或脱敏
pause  等待确认、登录、授权或补充信息
block  平台强制禁止，用户确认也不能绕过
~~~

风险按实际影响、数据去向、可恢复性、环境和参数判断，不按是否跨 Workspace 判断。

业务例子：查询订单自动执行；批量退款需要确认；尚未登录时暂停并引导登录；跨租户读取客户数据直接阻止。

Credential 可以由可信执行器使用，但原值不进入模型、回答、Memory、事件正文或观测存储。后台只查看引用、指纹、Scope、过期时间和注入结果。

## 9. 连续性、多智能体与可靠执行

### 9.1 普通交互

普通 Turn 依赖持久事件、局部 Checkpoint 和 ToolCall 结果恢复：

- Resume：从最后事件和工作状态继续。
- Fork：从指定 Turn 分叉为新 Thread。
- Steer：运行中注入补充要求，在下一安全决策点生效。
- Interrupt：停止继续行动，保留已经完成的事实。
- Regenerate：同一条用户消息不复制；旧回答标记为被替代，新回答成为当前展示。

Turn 执行中的普通新消息进入可编辑、删除和排序的 PendingInput 队列；“引导”把选中输入送入当前 Turn，默认在下一安全点应用，只有显式选择 interrupt_generation 且 Runtime 确认后才中断当前生成；“停止”只请求停止当前 Turn，不自动发送队列下一条。

### 9.2 副作用

有副作用的 ToolCall 使用稳定 operation_id，并记录 effect status：

- not_started
- confirmed_success
- confirmed_partial
- confirmed_failure
- unknown_effect

超时后先向目标系统核对。确认成功就复用结果，确认失败且安全才重试，无法确认则暂停人工处理。重新生成回答不能重复发邮件、付款或写业务数据。

### 9.3 多智能体

默认协作单位是 Child Thread：

- Delegate：对话主导 Agent 委派明确子任务。
- Parallel：多个 Child Thread 并行，对话主导 Agent 汇总。
- Handoff：显式把主责交给另一个 Agent。
- Agent-as-Tool：把受限 Agent 能力当成一个工具调用。
- Workflow Agent：固定顺序、并行或循环可写入 Agent 的 Harness/Workflow 配置。
- A2A：外部 Agent 保持独立身份和会话。

Child Thread 拥有独立上下文、事件、权限、预算和 Trace，只把结构化任务说明、必要资料与结果返回父 Thread。它只能由活跃父 Invocation 通过受控命令创建；子 Runtime 不能直接写父 Thread。取消先进入 cancel_requested，子 Runtime 确认后才成为 cancelled。主导 Agent 交接统一使用 UserActionRequest 等待员工确认（交接语义属后续 Agent 调用专题），不另建一套交接事实。

### 9.4 Temporal 的位置

Temporal 只用于：

- 定时、批量和无人值守任务。
- 长时间等待授权、回调或外部事件。
- 跨服务、跨天且需要持久恢复的工作。
- 部署、评测、知识构建等后台任务。

普通模型调用和短 ToolCall 不强制包装成 Temporal Activity。Temporal 承载员工会话中的长等待时，员工端仍只看到 Thread、Turn、Item 和 Event；部署、评测、知识构建等后台任务仍显示为 Job 和 JobEvent。

## 10. 发布、Runtime、观测与评测

### 10.1 发布与 Runtime

Agent 使用 VeADK 代码开发，支持托管与标准外部 Runtime：

- 托管 Runtime：SnowHarness 提供统一发布入口，底层接公司 CI/CD。
- 外部 Runtime：通过标准协议接入；只提供裸 URL 且无法说明能力、身份和事件语义的服务不接入。

AgentRevision 与 RuntimeRevision 通过 DeploymentRoute 组合。Invocation 启动时生成不可变 ExecutionBinding；新 Turn 或显式 Regenerate 的新 Invocation 使用当前路由。发布回滚只影响后续执行，不能撤销已经发生的业务副作用。

可执行 Revision 使用内容 digest、签名、SBOM 和 provenance 证明来源；未验证制品不能进入 DeploymentRoute。Hosted 与 External Runtime 都要通过同一套身份、Event 幂等、命令 ack、Credential 隔离和恢复语义一致性用例。

### 10.2 观测

每个 Invocation 都产生结构化 Trace；Turn、Child Thread 和后台 Job 通过 id 聚合这些 Trace：

- Agent、模型、Tool、知识、Memory、环境和外部系统调用关系。
- 状态、耗时、Token、费用、错误、重试和权限结果。
- 实际 Agent Revision、Skill hash、Tool Schema hash 和数据来源。

内容采集按策略分级：

| 模式 | 内容 |
|---|---|
| metadata | 结构、状态、用量、hash 和错误 |
| redacted | 额外保存脱敏后的输入输出 |
| diagnostic | 在授权范围和有效期内保存更完整诊断内容 |

Credential 原值和模型供应商未返回的隐藏思维链在任何模式下都不采集。Thread 和 Turn 聚合多个 Invocation Trace，Trace 不是业务事实源。

### 10.3 评测

评测复用真实 Agent Runtime、Tool 实现和事件结构，但只连接测试环境。评估内容包括：

- 最终答案与文件结果。
- Tool 选择、参数、顺序和外部状态。
- 权限与高风险操作是否正确处理。
- 上下文约束、Memory 命中和压缩质量。
- 延迟、Token、成本和稳定性。

Agent 自身修订可以配置发布门禁。普通 Skill/Tool 文本或 Schema 变化不触发所有 Agent 的批量回归；高风险能力变化、固定部署或明确策略才运行针对性评测。

## 11. 管理后台

管理后台按管理员任务组织：

| 分组 | 管理内容 |
|---|---|
| 智能体 | Agent、Revision、访问范围、委派范围、发布和部署 |
| 能力与知识 | Skill、Tool、Knowledge Base、知识图谱、模型与连接；MCP 待确认 |
| 会话与协作 | Thread、Turn、Item、用户操作请求、Child Thread 和会话事件 |
| 运行与环境 | Invocation、Job、Runtime、Desktop、Cloud、Remote、Sandbox、执行队列和容量 |
| 观测与评测 | Trace、事件时间线、日志、评测集、实验和线上评估 |
| 安全与审计 | 策略、审批、授权、Credential 诊断、安全事件和不可修改审计 |
| 生产运维 | Event 投影 lag/隔离、Runtime 就绪、Job 命令、执行所有权、SLO 和告警 |
| 平台设置 | 组织、租户、模型、配额、保留策略、Legal Hold、删除进度和基础设施接入 |

管理员不需要逐个维护每次实际执行清单。平台从 ExecutionBinding、CapabilityUse、ToolCall/Effect、Permission、ThreadEvent/JobEvent 与 Trace 组合展示“本次实际用了什么、为什么允许、在哪里执行、产生了什么影响”。

Agent 默认全员可用，也可按部门、用户组、岗位角色或用户限制。同一份范围同时控制员工端展示和服务端使用。内部测试通过收窄范围完成，不新增“测试中”生命周期。

## 12. 关键验收场景

| 场景 | 应有表现 |
|---|---|
| 切换模型 | 当前 Invocation 不变；下一 Turn 或显式 Regenerate 的新 Invocation 使用新模型，会话历史不丢 |
| 切换 Agent 约束 | Thread 不保存主 Agent；某 Turn 的 Agent 约束由对应 Invocation 冻结，变化必须显式，历史与 Workspace 可继续使用 |
| Skill 更新 | 新决策按需加载当前内容并记录 hash，不批量生成 Agent Revision |
| Tool Schema 更新 | 下一次 ToolCall 前刷新；进行中的调用不变 |
| 本地文件任务 | Desktop 执行，输出默认留在原文件位置 |
| Workspace 切换 | 用户显式切换并产生事件，不隐式迁移文件 |
| 重试“你好” | 用户消息只有一条，旧回答被替代，不出现多条“你好” |
| 运行中补充要求 | 默认排队；选择“引导”后在安全决策点进入当前 Turn |
| 业务系统未登录 | pause，完成登录后恢复原 ToolCall |
| 跨系统办理任务 | 优先调用受控接口；需要页面登录态时由 Desktop 打开目标系统并继续，敏感提交等待员工确认 |
| 批量删除 | 展示具体影响并确认；平台禁令不能靠确认绕过 |
| Tool 超时 | 先核对 effect，不能盲目重复副作用 |
| 子智能体 | 独立 Child Thread，仅回传必要结果和 Artifact |
| 记忆写入 | Runtime 只产生 MemoryCandidate；策略接受后才有 MemoryEntry |
| Job 重跑 | 原 Job 保持终态和历史；创建 `replaces_job_id` 指向原 Job 的新任务 |
| Event 投影失败 | checkpoint 停在坏事件前；隔离可见，修复后按原 sequence 重放 |
| 多设备打开会话 | 活跃 Invocation 不静默迁移；旧设备回调用 lease epoch 拒绝 |
| 删除命中 Legal Hold | 请求显示 blocked_by_hold，不伪装成已物理清理 |
| Runtime 发布 | 未验证制品或基础一致性用例失败时不能进入 Route |
| 管理排障 | 从 Thread 进入 Turn 事件与 Trace，看到实际版本、Schema、权限、成本和错误 |

## 13. 文档索引

| 文档 | 内容 |
|---|---|
| 文档 | 内容 |
|---|---|
| [agent-control-plane.md](./agent-control-plane.md) | Agent、Revision 与控制面边界 |
| [runtime-control-plane.md](./runtime-control-plane.md) | Runtime、Conformance 与执行面 |
| [artifact-trust.md](./artifact-trust.md) | Artifact、Attestation 与撤销事实 |
| [publication.md](./publication.md) | 发布与撤回历史 |
| [routing.md](./routing.md) | RouteSet、Activation、Projection 与 Resolver |
| [execution-binding.md](./execution-binding.md) | 执行证据冻结与事务校验 |
| [hosted-provisioning.md](./hosted-provisioning.md) | 托管开通 Saga、Worker 与 Lease |
| [conversations.md](./conversations.md) | Thread、Turn、Event 与跨端连续性 |
| [api-and-events.md](./api-and-events.md) | HTTP API、Event 与幂等边界 |
| [security.md](./security.md) | 身份、授权、凭证与审计 |
| [persistence.md](./persistence.md) | MySQL 数据模型与约束 |
| [contracts-and-conformance.md](./contracts-and-conformance.md) | 机器合同与一致性验证 |
| [decision-ledger.md](./decision-ledger.md) | 已确认决定与待确认边界 |
