# 统一领域模型

## 1. 结论

采用五个彼此分开的领域：控制与配置、会话交互、执行、上下文与资源、观测与治理。统一的是对象身份、引用方式、状态边界和事件语义，不是把所有对象塞进一张万能资产表。

~~~mermaid
flowchart LR
  subgraph Control["控制与配置"]
    Agent["Agent / AgentRevision"]
    Runtime["Runtime / RuntimeRevision"]
    Deploy["DeploymentRoute"]
    Capability["Skill / Tool / Knowledge / Policy"]
  end

  subgraph Interaction["会话交互"]
    Thread["Thread"] --> Turn["Turn"]
    Turn --> Item["Item 当前投影"]
    Turn --> Event["Event 仅追加变化记录"]
  end

  subgraph Execution["执行"]
    Job["Job 后台任务"] --> JobEvent["JobEvent 后台变化"]
    Job --> Invocation["Invocation"]
    Turn --> Invocation
    Invocation --> Attempt["Attempt 仅基础设施重试"]
    Invocation --> Binding["ExecutionBinding"]
    Invocation --> ToolCall["ToolCall / Effect"]
  end

  subgraph Context["上下文与资源"]
    Workspace["Workspace / Attachment"]
    Memory["Memory"]
    Knowledge["Knowledge"]
    Artifact["Artifact"]
  end

  subgraph Observe["观测与治理"]
    Trace["Trace / Span"]
    Eval["Evaluation"]
    Audit["Audit"]
  end

  Agent --> Deploy --> Binding
  Runtime --> Deploy
  Capability --> Binding
  Workspace --> Binding
  Invocation -->|属于 Turn 时| Event
  Invocation -->|属于 Job 时| JobEvent
  Event --> Item
  Invocation --> Trace
  Event --> Audit
  Trace --> Eval
~~~

业务例子：员工发出“分析本地销售表并生成报告”。`Thread` 保存连续会话，`Turn` 表示本次正式输入，`Item` 保存用户消息、进度和最终报告，`Event` 记录它们如何变化；`Invocation` 表示 Agent 实际执行了一次，`ExecutionBinding` 记录当时采用的 Agent Revision、Runtime、模型、环境和策略；文件位置归 Workspace，调用细节归 Trace。它们可以互相引用，但不会互相冒充。

## 2. 统一规则

### 2.1 稳定身份与不可变修订分开

可发布配置对象都采用“稳定对象 + 不可变修订”：

| 稳定对象 | 不可变修订 | 切换方式 |
|---|---|---|
| Agent | AgentRevision | DeploymentRoute 指向新修订 |
| Runtime | RuntimeRevision | DeploymentRoute 指向新修订 |
| PolicySet | PolicyRevision | 组织或 Agent 策略绑定切换 |
| Skill | SkillVersion | 当前版本指针或运行时解析 |
| Tool | ToolSchemaRevision | Tool Gateway 发布新 Schema |
| KnowledgeDocument | KnowledgeDocumentRevision | 索引完成后切换当前修订 |

稳定对象用于目录、权限和引用；修订用于发布、回滚和历史解释。修改 Skill、Tool 或知识不会连带创建 AgentRevision。

业务例子：公司写作 Skill 从 1.4 更新到 1.5，新决策点可以加载 1.5；合同 Agent 本身没有变化，不产生新 AgentRevision。某次执行实际读取了哪个版本和 hash，由 `CapabilityUse` 记录。

### 2.2 写模型和读模型分开

- 写模型只接受所属领域允许的命令，例如创建 Turn、发布 AgentRevision、解析用户确认。
- `Item` 是会话当前投影，允许由事件投影器更新状态或标记被替代。
- `Event` 是仅追加记录，写入后不修改；纠正通过新事件表达。
- “本次实际执行记录”、管理时间线、成本报表和能力使用关系都是读模型，不再成为人工维护的配置源。

业务例子：管理员查看“本次用了什么”时，后台组合 `ExecutionBinding + CapabilityUse + ToolCall + ThreadEvent/JobEvent + Trace`；不会要求 Agent 负责人预先填写一份 Run Manifest。

### 2.3 员工对象与内部执行对象分开

员工端的主层级固定为：

~~~text
Thread → Turn → Item
              ↘ Event（变化与续读）
~~~

`Invocation` 和 `Attempt` 是内部执行对象。每次实际 Agent 执行必有 Invocation；只有整个 Invocation 因基础设施问题重新调度时才物化 Attempt。员工可以看到“正在处理、等待确认、已中断、失败”等结果，但不需要理解 Worker 重连或 Activity Attempt。

业务例子：单次模型请求超时只在 Model Span 内重试；Worker 失联导致整个 Invocation 从检查点重新调度时才创建 Attempt。员工仍只看到一个 Turn；重新生成回答则创建新的 Invocation 和新 Agent Message Item，原用户消息不复制。

### 2.4 逻辑资源与执行位置分开

- Workspace 是员工看到的逻辑工作位置和默认路径基准。
- WorkspaceBinding 指向 Desktop、Cloud 或 Remote 上的实际位置。
- WorkspaceAttachment 是当前任务额外挂载的文件、目录或对象。
- EnvironmentDefinition 定义可执行能力与策略。
- EnvironmentLease 是某次 Invocation 实际获得的执行实例。
- FilesystemCheckpoint 只描述文件系统恢复点，不代表会话历史。

业务例子：Thread 默认 Workspace 在 Cloud，员工从 Desktop 附加本地 `Downloads/a.xlsx`。会话无需迁移，平台新增一个本地 Attachment，并把读取动作路由到对应 Desktop EnvironmentLease。

### 2.5 业务事实、遥测和审计分开

| 数据 | 回答的问题 | 事实来源 |
|---|---|---|
| Event | 会话中发生了什么变化 | ThreadEvent |
| Item | 当前应向员工展示什么 | Event 投影 + 受控命令 |
| Trace / Span | 调用在哪里耗时、消耗多少、为何失败 | 运行遥测 |
| Audit | 谁修改了配置、批准了什么 | 管理与安全审计 |
| Evaluation | 结果是否符合测试标准 | 评测运行与结果 |

Trace 不反向决定业务状态，Audit 不复制聊天全文，Event 不承担每个 Token delta 的永久存储。

业务例子：ToolCall 完成是一个持久 Event；网络 DNS 分解耗时属于 Span；管理员修改 Tool 风险级别属于 Audit；该 Tool 在测试集上的正确率属于 Evaluation。

## 3. 控制与配置领域

### 3.1 Agent

`Agent` 是 Harness 可治理、可调用的一类智能体资产，保存稳定身份、负责人、可见范围和当前发布信息；它不是唯一可运行资产，也不是 Thread 或基础 Harness 执行存在的前置条件（Agent 目录为空是合法状态）。`AgentRevision` 保存 Agent 自身不可变的代码、指令、默认模型策略、权限要求、委派范围和制品摘要。

以下变化生成 AgentRevision：

- Agent 代码、agent.yaml 或基础指令变化。
- 默认模型策略、权限要求或允许委派范围变化。
- Agent 自身启动参数或不可变制品变化。

以下变化不生成 AgentRevision：

- Skill 正文、Tool 描述或 Schema、Knowledge 内容、Memory 内容变化。
- RuntimeRevision 独立发布；由 DeploymentRoute 决定新 Invocation 使用哪个组合。

### 3.2 Runtime 与路由

`Runtime` 表示一种逻辑运行入口；`RuntimeRevision` 表示一次不可变部署制品或外部协议配置；`DeploymentRoute` 把 AgentRevision 路由到 RuntimeRevision。

~~~mermaid
flowchart LR
  Agent --> AgentRevision
  Runtime --> RuntimeRevision
  AgentRevision --> Route["DeploymentRoute"]
  RuntimeRevision --> Route
  Route --> Invocation
~~~

Route 可以按组织、用户范围、环境、比例和优先级选择新 Invocation。已开始的 Invocation 不因 Route 更新而换代码。

业务例子：合同 Agent 的 Revision 18 先把 10% 新请求路由到 RuntimeRevision 7，稳定后切到 100%；已经运行的任务仍使用启动时的绑定。

### 3.3 能力目录不是万能资产表

Skill、Tool、Knowledge Base、Model、Connection 和 Agent 保持各自表和发布规则。管理后台通过 `CatalogEntry` 读模型提供统一搜索、标签、负责人、状态和可见范围；所有写操作仍回到原领域 API。

员工选择器和 Agent Loop 使用同一个 `CapabilityCatalog`（能力目录查询边界），但返回视图不同：员工视图只返回可选择项、不可选原因和当前目录 revision；Runtime 视图还返回能力类型、稳定 id、当前修订/hash、输入输出 Schema 引用、风险摘要和选择依据。目录 revision 只用于发现结果的缓存与失效，不把所有候选固定进 Invocation。Tool 真正调用前仍要按稳定 id 读取一次 Schema；Skill 真正加载时读取正文并写 `CapabilityUse`。

能力列表变化通过控制面临时 `catalog.changed` 通知或下一次 search 的 revision 差异暴露；它不是 ThreadEvent/JobEvent，不进入会话持久 Event catalog。Runtime 不能把自己发现的未授权能力直接登记为平台能力，也不能根据展示名称调用 Tool。

业务例子：管理员从统一搜索找到“ERP 查询”，点击后进入 Tool 管理；不能把它当 Skill 修改正文，也不能用一套 `resource.status` 状态机强行描述 Agent 发布和知识索引。

业务例子：模型搜索“读取销售数据”，目录返回两个 Tool 和一个 Skill。模型先加载 Skill，实际调用其中一个 Tool 前读取其当前 Schema；另一个只被列出但没有使用，不写 `CapabilityUse`。

### 3.4 MCP 边界

不创建独立 MCP 产品对象。`ToolProvider` 和 `Connection` 使用协议中立的定义，可由内置 Tool、HTTP/OpenAPI、MCP 或外部 Agent Adapter 提供。是否在后台增加 MCP 专属菜单和运营能力仍不在本次定案范围。

## 4. 会话交互领域

### 4.1 Thread

Thread 是连续会话和协作容器，负责：

- 所属用户、租户（Thread 不保存主 Agent）。
- 默认 Workspace、可选 Goal 和父子关系。
- Turn、Item、Event 和 PendingInput 的归属。
- 会话级可见状态、标题、置顶、归档和删除。
- 默认 Environment 偏好；当前可用环境由身份、设备和平台状态动态计算。

Thread 不固定模型、Skill/Tool 内容版本、物理 Worker 或容器。

### 4.2 Turn

Turn 是一次被 SnowHarness 正式接纳、进入指定 Thread 员工时间线的输入或触发周期。它通常由用户消息触发；需要在会话中主动推送并允许员工继续交互的定时提醒或业务事件也可创建 Turn。审批恢复不创建新 Turn，批量、无人值守、部署、评测和知识构建使用 Job。

Turn 从 `accepted` 开始，在以下状态之一结束或暂停：

~~~text
accepted → queued → running → completed
    ↘ failed       ↘ failed
    ↘ cancelled    ↘ cancelled
                    ↘ waiting_user → running
                    ↘ interrupted
accepted → completed  （仅无 Invocation 的结果投影 Turn）
completed / interrupted / failed → regenerating → completed
                                              ↘ 原终态
~~~

`turn.accepted` 表示输入和 Turn 已持久化；`turn.started` 只表示首个 Invocation 开始。无 Invocation 的 job_result_projection Turn 允许在同一事务按 turn.accepted → item.created/completed → turn.completed 结束，不产生 queued/started。Regenerate 期间 Turn 保持 regenerating，新 Invocation 的开始由 `invocation.started` 表示。`waiting_user` 表示当前 Turn 和 Invocation 暂停但仍可恢复；`completed / interrupted / failed / cancelled` 是终态，前三者可通过显式 Regenerate 暂时进入 regenerating。Regenerate 失败且有旧结果时恢复 completed，无旧结果时恢复原 failed/interrupted。系统触发的 Turn 可以没有 user_message Item，但必须保存 trigger type 和 trigger reference。

Turn 只保存交互状态、active/latest/adopted Invocation 引用、最终 Item 和序列范围：active 是当前已排队/运行/等待执行，latest 包含失败的最新 Regenerate，adopted 是当前正式 Agent 结果的来源。系统投影结果没有 adopted Invocation。实际 AgentRevision、模型、Environment、Token、费用和重试属于各 Invocation 的 ExecutionBinding/Trace；Turn 详情只提供聚合读模型。

### 4.3 Item

Item 是持久、可查询、可展示或可进入模型上下文的内容单元。核心类型包括：

| 类型 | 内容 | 是否默认进入模型上下文 |
|---|---|---|
| user_message | 已接纳的用户输入 | 是 |
| user_guidance | 通过 Steer 接纳到当前 Turn 的补充要求 | 是 |
| agent_message | Agent 正式回答 | 是，按压缩策略 |
| public_progress | 可向员工展示的进度 | 否 |
| plan | 当前计划或任务清单 | 按需 |
| tool_call / tool_result | 工具请求与结果摘要，引用执行领域 ToolCall | 按需 |
| user_action_request | 确认、登录、授权或补充信息 | 是 |
| artifact / file_change / job_result | 产物、文件变更或后台结果投影引用 | 按需 |
| child_thread | 子任务关系与结果 | 摘要进入 |
| error | 员工可理解的错误 | 按需 |

Item 保存当前展示状态，可以被 Event 更新或标记为 `superseded`，但不能无痕覆盖历史。ToolCall、UserActionRequest、Artifact 和 ThreadRelation 以唯一 item_id 外键指向员工投影，Item 不再保存不可校验的多态反向引用，也不成为第二份执行事实。大文件、日志和二进制内容只保存 Artifact 引用。

业务例子：Agent 流式回答时，客户端接收临时 delta，不提前写 streaming Item；完成后落一个 `agent_message` Item，并追加 `item.completed` Event。不会永久保存几千条 Token Event。

### 4.4 Event

Event 是 Thread 内有序、仅追加的变化记录。后台 Job 使用独立的 `JobEvent`，不能为了复用 ThreadEvent 而制造 Thread 或 Turn。每条 ThreadEvent 至少包含：

- 全局 event id 和 Thread 内单调递增 sequence。
- event type、schema version、occurred_at。
- 可选 turn_id、item_id、invocation_id。
- actor、correlation_id、causation_id 和 idempotency_key。
- 不含 Credential 原值的 payload。

所有执行相关 ThreadEvent，包括 Invocation、Attempt、ToolCall、Permission 和 Effect 状态变化，都必须填写 `invocation_id`。纯 Job 的相同变化写入按 `job_id + event_sequence` 排序的 JobEvent；只有通过显式会话命令投影到某个 Turn 时才追加 ThreadEvent。

持久 Event 只记录可恢复或可审计的边界，例如 Turn 开始、Item 完成、ToolCall 状态变化、审批请求、Workspace 变化和 Child Thread 关系。Token delta、心跳和高频进度默认只通过实时通道传输，必要时合并为持久进度 Item。

### 4.5 PendingInput

运行中的普通新输入先进入 PendingInput 队列，尚未成为 Item，因此可以编辑、删除和排序。接纳为当前 Turn 的 steer 时先生成 pending user_guidance Item 和 `turn.steer_queued`；Runtime 在安全点 ack 后才完成 Item 并写 `turn.steered`。接纳为下一 Turn 的正式输入时生成 user_message Item。waiting_user 不接受 steer，只能解析对应 UserActionRequest。

业务例子：Agent 正在生成报告，员工连续补充三条要求。员工可以在队列中调整顺序；选择“引导”后，平台先排队 steer command，Runtime 确认已在安全点应用后才记录 `turn.steered`，而不是伪造第二个用户 Turn 或提前宣称已应用。

### 4.6 父子 Thread

多智能体协作使用 `ThreadRelation` 表达 parent/child、delegate 或 fork 等确实存在两个 Thread 的关系。创建 delegate Child Thread 必须带父 Invocation、结构化任务、上下文传递策略、目标 Agent 和预算上限；服务端重新计算目标 Agent 权限，不能继承父 Runtime Token。Child Thread 拥有自己的 Turn、Invocation、Item、Event、权限和预算，父 Thread 只接收结构化任务、状态、结果和 Artifact 引用。父级取消是持久命令；只有 Child Thread 确认终态后才记录 `child_thread.cancelled`。

Child Thread 完成时，平台从子 Thread 的最终 Item 和 Artifact 生成不可变结果引用，并在父 Turn 创建或更新唯一的 `child_thread` Item；子 Runtime 不能直接向父 Thread 写消息。Thread 不保存主 Agent 身份（专题 01 已删除 `primaryAgentId`）；Agent 偏好、交接（handoff）与调用规划的统一语义由后续 Agent 调用专题定义，专题 01 不在 Thread 上伪造主 Agent 事实，也不伪造 ThreadRelation。

固定 Workflow 的步骤执行可以使用内部 Workflow/Invocation 记录，不强制把每一步都伪装成 Child Thread。

业务例子：财务 Agent 委派风险 Agent 审核报表时，平台建立 Child Thread 并限制其只读附件、最多两个 ToolCall。风险 Agent 完成后父会话只收到结论和报告 Artifact；若 Workflow 建议“后续改由风险 Agent 负责”，交接语义由后续 Agent 调用专题定义。

## 5. 执行领域

### 5.1 Invocation

Invocation 表示一次从调度开始，到完成、失败、中断或取消的 Agent Loop 执行；它可以经历 `waiting_user` 暂停并在用户操作后恢复。每次实际 Agent 执行必有 Invocation，但它不出现在员工导航中。一个 Turn 可以有多个 Invocation：

- 首次生成一个。
- Regenerate 创建新的 Invocation。
- 旧 Invocation 和回答被 supersede，但保留历史关系。

Child Thread 的 Invocation 属于子 Thread 自己的 Turn，不属于父 Turn。UserActionRequest 解析后继续原 Invocation 和 ExecutionBinding；若 Runtime 需要重新调度，则创建同一 Invocation 的 Attempt，不能由 Adapter 自由改变领域切分。

Invocation 不是员工端导航层级，不取代 Turn。

### 5.2 Job

Job 表示不以员工会话为主的定时、批量、无人值守、部署、评测或知识构建任务。Job 可以拥有多个 Invocation，并以独立 JobEvent 保存后台变化。后台结果需要进入会话时，只能在已有来源 Turn 创建 job_result 投影 Item，或先创建 system-triggered Turn 再创建投影 Item；不能把 Job Artifact 改挂为会话产物，不能在 Thread 下创建无 Turn Item，也不伪造用户消息。

同一个 Invocation 必须且只能属于一个 Turn 或一个 Job。Regenerate 仍属于原 Turn：它以专门命令创建新 Invocation、更新 Turn 当前结果并用 Item superseded 关系保留旧回答。Invocation 内的基础设施重调度只创建 Attempt；对已经终止的 Job 执行“重新运行”则创建新的 replacement Job 并引用原 Job，不能把旧终态改回 queued。

Runtime 无权通过通用接口任意创建 Job。部署、评测、知识构建、定时或批量等所属领域服务创建 Job；公共 Job Command 只负责查询、请求取消和创建 replacement Job。取消同样采用请求与确认分开：`job.cancel_requested` 不等于已取消，调度器收敛所有可停止 Invocation 后才写 `job.cancelled`。

业务例子：管理员重跑失败的知识构建任务时，系统创建新 Job 并保留 `replaces_job_id`，旧 Job 的事件和结果不被覆盖；运行中的 Tool 已产生未知副作用时，取消命令不会伪造成功。

### 5.3 Attempt

Invocation 的初始执行直接记录在 Invocation 和 ExecutionBinding，不创建 Attempt 行。只有整个 Invocation 因 Worker 失联、Runtime 重连或检查点恢复而重新调度时才创建 Attempt；`attempt_no=1` 表示第一次基础设施重试。单个模型请求的供应商重试属于 Model Span，Tool 重试属于 ToolCall/Effect，Agent Loop 下一步也不是 Attempt。

业务例子：模型接口返回 503 并在同一 Worker 内重试，不增加 Attempt；Worker 崩溃后从检查点恢复，才创建 Attempt 1。Agent 先查订单再生成图表，也只是同一 Invocation 的两个动作。

### 5.4 ExecutionBinding

Invocation 启动时创建不可变 ExecutionBinding，记录：

- AgentRevision、RuntimeRevision 和 DeploymentRoute。
- 模型供应商与模型版本引用。
- 初始 EnvironmentLease、WorkspaceBinding 和策略修订；重试后的新 Lease 记录在 Attempt。
- Context checkpoint 或 assembly reference。
- 启动时配置 hash。

Skill、Tool、Knowledge 和 Memory 不全部预先锁成清单；只有实际使用后写入 `CapabilityUse`，记录资源 id、修订/hash、来源、选择原因和使用时间。

这既支持动态装配，也能回答历史执行使用了什么。

### 5.5 ToolCall、Effect 与 Credential

ToolCall 在调用前读取当前 Tool Schema，并把 schema revision/hash 固定到本次调用。AI 填业务参数，平台注入 actor、tenant、connection、credential reference 和 trace context。

有副作用的调用还需要：

- 稳定 operation_id。
- EffectRecord：`not_started / confirmed_success / confirmed_partial / confirmed_failure / unknown_effect`。
- PermissionDecision：`allow / pause / block`。
- UserActionRequest：确认、登录、授权或补充信息。

Credential 原值只在可信 Gateway 或执行器内短暂使用，不进入模型、Item、Event、Trace 或 Memory。

### 5.6 Actual Execution Record

“本次实际执行记录”定义为只读聚合，不单独建立第二份事实表：

~~~text
Invocation
+ ExecutionBinding
+ CapabilityUse
+ ToolCall / EffectRecord
+ PermissionDecision
+ ThreadEvent 或 JobEvent
+ Trace summary
= Actual Execution Record
~~~

它按 invocation_id 查询，只选择该 Invocation/Attempt/ToolCall 直接关联的 ThreadEvent 或 JobEvent 以及 Trace；纯 Job 执行不要求存在 ThreadEvent。该读模型没有独立 id、状态机、写接口或人工生命周期，因此不会形成第二套 Run。

## 6. 上下文与资源领域

### 6.1 Workspace

Workspace 是逻辑工作位置；同一个 Workspace 可拥有多个 Binding，例如某台 Desktop 的本地目录、Cloud volume 或远程仓库。Binding 的位置标识只在相应执行域内有效，本地绝对路径必须同时绑定 device_id，不能被云端直接解释。

Attachment 表示额外位置，不改变默认 Workspace。用户明确位置优先于默认位置。

### 6.2 Memory

Memory 记录经过来源、作用域、敏感性和有效期判断后可复用的事实。作用域固定为 Thread、Project/Workspace、User Preference、Agent-specific 或 Organization。只有通用 User Preference 默认允许跨 Agent；Project 和 Agent-specific 不扩大范围。

Agent/Runtime 只能提交 `MemoryCandidate`（记忆候选），不能直接写 `MemoryEntry`。平台先校验来源 Item、目标 Scope、敏感性、重复内容、过期时间和当前用户授权，再按策略接受、拒绝或进入人工复核。接受候选与创建/更新 MemoryEntry 在同一事务记录决定；被拒候选不会进入检索索引。Organization Scope 只能由具有组织记忆管理权限的主体批准，Runtime 提案不能自动扩大到组织。

业务例子：Agent 从本轮对话提议保存“用户默认使用中文”，平台可以按用户偏好策略自动接受；提议保存“项目数据库密码”会因敏感信息直接拒绝；提议把项目规则保存为组织记忆则进入管理员复核。

### 6.3 Knowledge

Knowledge Base 管理文档、修订、权限、索引状态和证据引用。知识图谱是 Knowledge Base 内部索引，不成为 Agent 单独绑定的第二套知识资产。Knowledge 内容变化不创建 AgentRevision。

### 6.4 Artifact 与文件变化

Artifact 保存逻辑产物、内容地址、媒体类型、大小、hash、来源和访问范围。FileChange 保存实际位置、变更类型、前后 hash 和关联 ToolCall。大内容放对象存储或原 Workspace，Item 和 Event 只保存引用与摘要。

## 7. 观测与治理领域

### 7.1 Trace

Trace 以 Invocation 为主要根节点，以 Span 表示模型、Tool、Knowledge、Memory、Environment 和外部系统调用。Turn、Thread 和 Job id 作为对应场景的聚合维度。采集模式为 metadata、redacted 或 diagnostic；隐藏思维链和 Credential 原值始终不采集。

### 7.2 Evaluation

EvaluationRun 引用确定的 AgentRevision、RuntimeRevision、测试数据集、测试环境和评分器。线上评测可以引用真实 Invocation，但不能修改其 Event 或 Item。

### 7.3 Audit

AuditEvent 记录管理员配置修改、发布、策略决策、用户授权和敏感访问。Audit 保存 actor、action、target、before/after hash、理由和时间，不复制无关聊天正文。

## 8. 聚合边界与事务

| 聚合 | 同一事务内保证 | 不跨事务强耦合 |
|---|---|---|
| Thread | Turn 接纳、Item 写入、Event sequence 分配 | Runtime 执行成功 |
| Turn | 交互状态迁移、所有 Invocation 关系、当前采用结果 | Trace 写入完成 |
| Job | 后台调度状态、所有 Invocation 关系 | 员工会话展示 |
| Agent | Revision 发布、当前发布指针 | Runtime 部署完成 |
| DeploymentRoute | 路由版本和并发更新 | 已开始 Invocation |
| ToolCall | Schema 固定、PermissionDecision、operation_id | 外部系统最终一致性 |
| UserActionRequest | 单次解析和授权结果 | 外部登录页面状态 |
| MemoryCandidate | 来源、Scope、安全判定与接受结果 | 向量索引完成 |
| RetentionPolicy / DeletionRequest | 适用范围、Legal Hold 判断和删除任务创建 | 对象存储物理回收完成 |

跨领域通过 idempotent command（幂等命令）和 Event 协调，不使用跨服务大事务。

业务例子：创建 Turn 时，用户 Item、Turn 和 `turn.accepted` Event 在一个事务提交；随后 Runtime 启动失败时追加失败 Event，不回滚用户已经发送的消息。

## 9. 删除与保留语义

| 操作 | 行为 |
|---|---|
| 删除 Thread | 先软删除并停止新执行；按组织保留策略异步清理 Item、Event、Trace 和临时 Artifact |
| 删除 Agent | 禁止新 Thread 和新路由；历史 Thread 继续引用其稳定身份与 Revision 摘要 |
| 撤销 Credential | 立即阻止后续注入；历史只保留 credential_ref 与指纹 |
| 删除 WorkspaceBinding | 停止后续访问；不自动删除用户原始本地文件 |
| 删除 Knowledge 文档 | 新检索不可见；历史 CapabilityUse 保留文档修订/hash 引用 |
| 删除用户 | 按组织身份与合规策略处理；不把跨用户共享知识级联删除 |

删除必须经过 `DeletionRequest`，由解析器计算资源范围、所有权、RetentionPolicy（保留策略）和 LegalHold（法律保留）；命中有效 LegalHold 的数据不进入物理删除，只返回被阻止的资源摘要。删除任务对每个存储后端保留可重放步骤和完成证明，Thread 删除不能顺带删除用户原始本地文件或共享 Knowledge。

具体保留天数由组织策略配置，不写死在领域模型中；但策略优先级固定为“Legal Hold > 法规/组织最短保留 > 用户删除请求 > 默认生命周期”。

业务例子：员工删除一条 Thread 时，会话 Item 和 Event 进入异步清理；引用的共享制度文档不删除，原始本地 Excel 不删除。若该 Thread 处于调查 Legal Hold，接口返回已受理但 blocked_by_hold，不伪装成已清除。

## 10. 不变量

1. SnowHarness 始终是 Harness 执行与编排主体，Agent 目录为空是合法状态；Agent 是可治理、可调用资产，不是唯一可运行资产，也不是 Thread/Route/Binding/Invocation 的存在前置。Runtime 是实际执行基础设施，所有真正执行必须通过正式 Runtime/Route/ExecutionBinding/Invocation 链。
2. Thread、Turn、Item 是员工交互主模型；ThreadEvent 是独立变化记录，后台 Job 使用 JobEvent。
3. ThreadEvent 在 Thread 内、JobEvent 在 Job 内 sequence 唯一且只追加；实时 delta 不冒充永久事件。
4. 一个已接纳用户输入只对应一个 user_message Item；Regenerate 不复制它。
5. Item 必须属于一个 Turn，状态变化必须有对应 ThreadEvent；ThreadEvent/JobEvent payload 都不保存 Credential 原值。
6. Invocation 启动后 ExecutionBinding 不变；Route 更新只影响新 Invocation。
7. Invocation 是每次实际 Agent 执行的内部记录；Attempt 只在整个 Invocation 被基础设施重新调度时创建，不表示模型 Span、ToolCall 或 Agent Loop 步骤。
8. ToolCall 开始后 Schema、权限结果和 operation_id 固定。
9. 有副作用的重试必须先检查 EffectRecord，`unknown_effect` 不自动重放。
10. Workspace 不是安全边界；Environment 与 Policy 才是强制边界。
11. 本地路径必须与 Desktop device/binding 一起解释。
12. Memory、Knowledge、会话事实和 Trace 不互相级联覆盖。
13. Trace 不决定业务状态；Actual Execution Record 是读模型。
14. 通用目录只是搜索投影，不替代各领域写模型。
15. Agent/Runtime 只能提交 MemoryCandidate，只有 Memory Policy 服务能写 MemoryEntry。
16. Child Thread 只能经父 Invocation 的受控命令创建；结果只能经关系投影进入父 Turn。
17. 已终止 Job 的重新运行创建 replacement Job，不复活原 Job。
18. Event 投影 checkpoint 只能在投影事务成功后前移；单个坏事件不能让后续事件越序生效。
19. 活跃 Invocation 不因另一设备打开 Thread 而迁移；执行环境变更必须显式请求，并由 Runtime ack 或新 Invocation 生效。
20. Legal Hold 优先于物理删除；删除完成必须能按存储后端给出证明。

## 11. 外部产品校准

本模型吸收的是当前工具已经验证的边界，而不是照搬其产品名：

- [Codex App Server](https://github.com/openai/codex/blob/main/codex-rs/app-server/README.md) 把 Thread、Turn、Item 作为客户端主对象，并提供 fork、steer、interrupt 与事件通知。
- [Claude Agent SDK Sessions](https://code.claude.com/docs/en/agent-sdk/sessions) 明确会话恢复的是对话，不自动恢复文件系统状态，因此 Conversation 与 FilesystemCheckpoint 必须分开。
- [Qoder Events Stream](https://docs.qoder.com/cloud-agents/events-stream) 使用 `Last-Event-ID`、增量事件和历史续读，支持独立 Event 游标。
- [VeADK Runner](https://github.com/volcengine/veadk-python/blob/main/docs/content/docs/framework/runner.mdx) 使用 app、user、session 隔离并从 Runner 产出 Event，说明外部 Runtime 可通过 Adapter 映射到统一协议。
- [AgentKit Harness](https://github.com/volcengine/agentkit-sdk-python/blob/main/docs/content/2.agentkit-cli/5.harness.md) 把配置、部署、调用和结构化 Tool 定义分开，支持平台控制面与 Runtime 执行面分离。
- [MCP Tools 规范](https://modelcontextprotocol.io/specification/2025-11-25/server/tools) 使用 `tools/list`、JSON Schema、分页和 list changed 通知，支持能力目录 revision 与单次 ToolCall Schema 固定。
- [Qwen Code](https://github.com/QwenLM/qwen-code) 同时提供 Skills、Subagents、Teams、MCP 和 daemon 多客户端会话，说明能力发现、多智能体和客户端连接不应共用一个万能执行对象。
- [OpenCode](https://github.com/anomalyco/opencode) 使用持久 Session Event 与消息投影并存，说明 Event 账本和 Item 查询模型不必二选一。
- [OpenHands](https://github.com/OpenHands/OpenHands) 把 Conversation 管理与 Event Service、Sandbox、Agent 版本来源分开，支持本方案的领域拆分。

这些项目不替 SnowHarness 决定企业权限、Credential、Memory 作用域和后台治理；这些仍以 agentkit 会话中已确认的产品边界为准。
