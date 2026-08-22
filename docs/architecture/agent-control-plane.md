# Agent、Thread 与 Runtime

## 1. 领域关系

~~~mermaid
flowchart TB
  Agent["Agent<br/>稳定身份与默认策略"] --> Revision["Agent Revision<br/>指令、代码、模型策略、权限、委派策略"]
  Agent --> Thread["Thread<br/>默认 Workspace、连续历史"]
  Thread --> Goal["Goal 可选"]
  Thread --> Turn["Turn"]
  Turn --> Item["Item 当前内容"]
  Turn --> Event["Event 有序变化"]
  Event --> Item
  Turn --> Loop["Agent Loop"]
  Loop --> Context["Context Assembly"]
  Loop --> Capability["Capability Discovery"]
  Loop --> Environment["Execution Environment"]
  Loop --> Child["Child Thread"]
  Revision --> Route["DeploymentRoute"]
  RuntimeRevision["RuntimeRevision"] --> Route
  Route --> Invocation["Invocation"]
  Invocation --> Attempt["InvocationAttempt（简称 Attempt）<br/>基础设施重调度记录"]
  Environment --> Desktop["Desktop"]
  Environment --> Cloud["Cloud"]
  Environment --> Remote["Remote"]
  Environment --> Sandbox["Sandbox"]
~~~

这个模型把“用户会话”“智能体定义”“执行位置”和“底层可靠机制”分开。普通员工交互不需要理解 Run、Attempt、Step 或 Workflow。

## 2. Agent

SnowHarness 自身始终是 Harness 执行与编排主体：即使 `Agent` 表为空，它仍能接受任务、创建 Thread、接纳 Turn 并通过正式 Runtime/Route/ExecutionBinding/Invocation 链执行。Agent 不是唯一可运行资产，也不是 Thread 或基础 Harness 执行存在的前置条件；**Agent 目录为空是合法状态**，只影响 Agent 能力选择器，不影响 Harness 本身。

Agent 是 Harness 可治理、可调用的一类智能体资产，保存：

- 名称、介绍、分类、负责人和 enabled。
- 基础指令与行为边界。
- 默认模型策略、Skill、Tool、Knowledge 和 Memory 挂载建议。
- 支持的运行能力与环境。
- 允许委派或调用的 Agent 范围。
- 员工使用范围。
- 当前发布 Revision 与可用 DeploymentRoute 摘要。

Agent 不保存：

- 每次模型实际收到的全部上下文。
- 每次 ToolCall 的具体 Schema 副本。
- 动态 Skill 的静态依赖树。
- Credential 原值。
- 另一个 Application 实体。

业务例子：“月度经营分析 Agent”定义报表目标、默认财务知识、可查询 ERP、可委派图表 Agent。张三和李四分别创建 Thread，拥有独立历史、文件、权限和结果。

## 3. Agent Revision

Agent Revision 只在 Agent 自身发生可发布变化时生成：

| 变化 | 是否生成 Revision | 原因 |
|---|---|---|
| 基础指令或 Prompt 修改 | 是 | Agent 行为定义改变 |
| VeADK 代码或 agent.yaml 修改 | 是 | 可执行制品改变 |
| 默认模型策略改变 | 是 | Agent 自身决策策略改变 |
| 权限要求或允许委派范围改变 | 是 | Agent 边界改变 |
| Agent 自身启动参数或不可变制品改变 | 是 | Agent 可执行定义改变 |
| RuntimeRevision 或 DeploymentRoute 改变 | 否 | Runtime 与路由独立发布，Invocation 启动时组合 |
| Skill 当前文本更新 | 否 | 运行时按需读取当前生效内容 |
| Tool 描述或 Schema 更新 | 否 | ToolCall 前动态发现并记录实际 Schema |
| Knowledge 文档变化 | 否 | 它是实时业务资料 |
| 用户 Memory 变化 | 否 | 它是作用域数据，不是 Agent 定义 |

Revision 记录不可变代码、指令、策略、制品摘要和发布时间。普通能力更新通过实际执行记录和风险审核治理，不连带生成大量 Revision。

业务例子：合同审查 Agent 代码未变，法律条款 Skill 增加一段解释，不发布 Agent Revision；如果 Agent 的审批策略从“只读建议”改为“可以提交审查结论”，则必须发布新 Revision。

## 4. 代码型 Agent 与 Adapter

不建设可视化业务编排器。Agent 使用：

- VeADK Python Agent。
- agent.yaml 定义的 root agent、sub agents、tools、model 和 instruction。

构建时自动加入 SnowHarness Adapter：

~~~text
Agent 项目
+ SnowHarness Adapter
= 标准 Runtime 制品
~~~

Adapter 负责：

- 统一 Agent 入口和健康检查。
- 接收 Thread、Turn、用户和租户身份。
- 输出标准化 Runtime Event，由平台生成或更新 Item。
- 接入 Context、Tool、Memory、Knowledge 与 Credential Gateway。
- 传播 Trace。
- 暴露 Runtime 能力，不让管理员凭想象勾选。

开发、测试、构建和部署仍属于普通项目流程。SnowHarness 提供统一 Agent 发布入口，底层接公司现有 CI/CD；具体公司接口不在本文定义。

火山项目导入时，agent.yaml 可作为 Agent 定义读取；agentkit.yaml 只提取通用入口与依赖信息，火山账号、地域、镜像仓库和专有部署字段不能直接执行。

## 5. Thread

Thread 是员工可见的连续工作容器，保存：

- 默认 Workspace 与默认 Environment 偏好；当前可用环境由平台动态计算。
- Turn 与事件历史。
- 当前可选 Goal。
- 文件、Artifact 和外部对象引用。
- PendingInput 队列。
- 压缩检查点与上下文索引。
- 父子 Thread 关系。

Thread 不固定：

- 某个模型永久版本。
- Skill 或 Tool 永久版本。
- Agent Revision 之外的动态能力内容。
- 物理容器或 Worker。

### 5.1 Thread 与 Agent 解耦

Thread 不保存主 Agent 身份，也不要求先有 Agent 才能创建。Thread 与 Agent 从"存在性强绑定"改为"调用时可组合"：Thread 是连续工作容器，Agent 是可治理资产，二者互不构成存在前置。

用户在某次 Turn / Invocation 主动偏好某个 Agent 的语义（preferred/required）、Agent 自动发现、排序与调用规划，均属于后续对应专题，专题 01 不在 Thread 上冻结主 Agent 身份，也不在 Thread 保存 `primaryAgentId`。

### 5.2 切换配置

配置变化都要记录，但生效边界不同：

- 用户切换模型：当前 Invocation 不变，下一 Turn 或显式 Regenerate 的新 Invocation 生效。
- Skill 当前内容变化：下一次需要加载该 Skill 的模型决策可以读取新内容。
- Tool 描述或 Schema 变化：下一次 ToolCall 前刷新。
- 默认 Environment 或 Workspace 切换：对下一 Turn 或显式 Regenerate 的新 Invocation 生效；用户当前 Turn 明确附加本地文件或目录时，可作为当前任务 Attachment 立即使用。

这些变化都不删除 Thread 历史。

业务例子：用户先让代码 Agent 在 Cloud 分析仓库，之后切换到 Desktop 运行本地测试。Thread 仍由代码 Agent 主持，只是 `thread.environment_changed` Event 改变后续新 Invocation 的默认路由。

## 6. Goal

Goal 是可选的持续目标，只在任务有明确终点、需要多次 Turn 持续推进时使用。普通问答、一次性文件修改和简单查询不创建 Goal。

Goal 保存：

- Objective：要达到的结果。
- Success Criteria：怎样算完成。
- Constraints：预算、时间、权限和业务限制。
- Current State：当前进度、阻塞和剩余工作。
- Status：active、blocked、completed 或 cancelled。

Goal 不能取代 Thread 消息、计划、事件或业务状态。它只是跨 Turn 的工作摘要。

业务例子：“把测试覆盖率提高到 85%”可以创建 Goal；“今天北京天气如何”不创建。

## 7. Turn

Turn 通常从一条正式用户消息开始；只有接入某个 Thread、需要进入员工时间线并允许后续交互的系统触发才创建 Turn。等待用户是可恢复暂停态，不表示 Turn 已结束。普通模型决策和 ToolCall 不是新的 Turn。

Turn 保存：

- 起始用户输入或 Thread 内系统触发原因。
- 员工可见状态、当前 active/latest/adopted Invocation 引用和正式结果 Item。
- Item/Event 序列范围、开始/等待/结束时间和稳定错误码。

Turn 不保存单一“实际 AgentRevision、模型、Environment、Token 和费用”。一个 Turn 经显式 Regenerate 可以有多个 Invocation，这些执行事实分别进入 ExecutionBinding 和 Trace；Turn 详情只展示可重建的聚合摘要。

Turn 状态固定为：

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

`accepted` 表示输入和 Turn 已在同一事务落库；`queued` 表示等待调度；`turn.started` 只在首个 Invocation 开始时产生。无 Invocation 的 job_result_projection Turn 可在同一事务从 accepted 进入 completed，不产生 queued/started。Regenerate 期间 Turn 保持 regenerating，新的 Invocation 用 invocation.started 表示实际开始；成功后进入 completed，失败且已有旧正式结果时也回到 completed，没有旧结果时恢复原 failed/interrupted。`waiting_user` 不是终态。模型请求局部重试和 Tool 重试进入 Trace/ToolCall；只有整个 Invocation 被 Worker 或 Runtime 重新调度时才增加内部 InvocationAttempt。

### 7.1 Turn 与 Job 边界

| 触发 | 使用对象 |
|---|---|
| 员工发送普通新消息 | 在原 Thread 创建下一 Turn |
| 员工选择 Steer | 生成 user_guidance Item 并进入当前 Turn |
| 员工完成确认、登录、授权或补充信息 | 继续当前 Turn 和原 Invocation；只有基础设施重调度才创建 Attempt |
| 要在员工会话中主动推送结果的定时提醒或业务事件 | 在指定 Thread 创建 system-triggered Turn |
| 批量、无人值守、部署、评测、知识构建 | Job → Invocation，不创建虚假员工 Turn |
| 后台 Job 最终需要员工接手 | 在已有来源 Turn 创建 job_result 投影 Item，或先创建 system-triggered Turn 再创建投影 Item；禁止在 Thread 下创建无 Turn Item |

Job 保存调度、批次、外部触发和后台生命周期；Turn 只保存会话接纳与员工可见状态。两者都可拥有 Invocation，但同一个 Invocation 只属于 Turn 或 Job 之一。

## 8. Item、Event 与内部执行

### 8.1 Item 是当前内容投影

Item 是持久、可查询、可展示或可进入模型上下文的内容单元：

| 类别 | 例子 |
|---|---|
| Message | user_message、user_guidance、agent_message、public_progress |
| Work | plan、tool_call、tool_result、user_action_request |
| Resource | artifact、file_change、job_result |
| Collaboration | child_thread |
| Result | error |

ToolCall、UserActionRequest、Artifact 和 ChildThread Item 只是员工可见投影；各领域表用唯一 item_id 外键指向投影，执行表仍是权限、副作用和重试的事实。Agent 流式 delta 不提前制造 streaming Item，完成时落正式 agent_message Item；可恢复进度使用独立 public_progress Item。Item 可以被新回答标记为 superseded，每次状态变化都有对应 Event，不能无痕覆盖历史。大文件和日志只保存 Artifact 引用。

### 8.2 Event 是仅追加变化记录

Event 在 Thread 内按 sequence 排序，表达 Turn、Item、ToolCall、授权、Workspace、连续性和协作状态变化。纠正通过新 Event 表达，不修改旧 Event。

~~~text
执行组件产生候选 Event
→ SnowHarness 校验身份、Schema、顺序和脱敏
→ 同一事务更新 Item/Turn 并追加 Event
→ 发布通知
→ Desktop / Web / 管理后台按 sequence 续读
~~~

Token delta、心跳和高频 Tool 日志走临时流，完成或异常时归并为持久 Item 和 Event。推送只负责通知，持久 Event 和 Item 才是恢复依据。VeADK、Codex、Claude 或其他 Runtime 的原始回调由 Adapter 映射，不能直接成为客户端协议。

### 8.3 Invocation 与 Attempt

每次实际 Agent 执行必有 Invocation，但它只存在于内部执行与管理排障中。首次执行和显式 Regenerate 分别创建 Invocation；Regenerate 不复制 user_message Item。初始执行直接记录在 Invocation，不创建 Attempt 行；只有整个 Invocation 因 Worker 失联、Runtime 重连或恢复而重新调度时才创建 Attempt 1..N。单个模型请求 503、ToolCall 重试和 Agent Loop 下一步不是 Attempt。

### 8.4 实际执行记录

平台从以下事实自动生成 Actual Execution Record：

~~~text
Invocation
+ ExecutionBinding（AgentRevision、RuntimeRevision、模型、环境、策略）
+ CapabilityUse（实际 Skill/Tool/Knowledge/Memory 及 hash）
+ ToolCall / Effect / Permission
+ ThreadEvent 或 JobEvent / Trace summary
~~~

它是只读聚合，不是管理员事先维护的配置源。详细字段和约束见 [统一领域模型](./domain-model.md)、[核心数据模型](./persistence.md) 和 [API 与 Event 边界](./api-and-events.md)。

## 9. Agent Loop

的运行核心是循环，不是预先展开的固定工作流：

~~~mermaid
flowchart LR
  Understand["理解目标与当前状态"] --> Inspect["查看索引与缺口"]
  Inspect --> Load["按需加载上下文或能力"]
  Load --> Act["调用模型 / Tool / 子 Agent"]
  Act --> Verify["验证结果与副作用"]
  Verify -->|未完成| Understand
  Verify -->|需要用户| Wait["等待确认 / 登录 / 信息"]
  Wait --> Understand
  Verify -->|完成| Finish["正式回答与完成事件"]
~~~

### 9.1 理解

读取当前用户输入、已确认约束和最近状态，确定当前问题与完成条件；若当前 Invocation 带 Agent 约束，则同时读取该 Agent 指令。

### 9.2 获取上下文

先看摘要、目录、文件地图和能力描述；只有需要时加载全文。Context Assembly 是 Agent Loop 的内部能力，不是管理员必须配置的独立产品。

### 9.3 行动

可以调用模型、Tool、Knowledge、Memory、Workspace、Child Thread 或 Sandbox。能力只能从平台允许的目录和环境获得。

### 9.4 验证

检查 Tool 结果、文件 diff、测试、业务系统状态和用户要求是否满足。模型声称“已完成”不等同于平台确认成功。

业务例子：Agent 修改代码后必须查看 diff 并运行相关测试；只有文件改变且测试通过，才生成完成回答。

## 10. 动态装配

Agent Loop 按需装配能力：

1. 平台提供 Agent 默认能力与员工本轮选择的可发现目录。
2. 模型先读取短描述，不把所有 Skill 与 Tool 正文塞进上下文。
3. 决定使用某 Skill 时加载当前生效内容，并记录 hash。
4. 决定调用 Tool 时刷新该 Tool 当前 Schema。
5. 平台对 ToolCall 做确定性权限、Credential 与风险判断。
6. 调用完成后记录实际 Schema、结果和副作用。

AgentRevision 用 `agent_interface_requirements.required/optional` 声明标准注入接口，例如 required dynamic_tools、optional steer。它表示 Agent 代码必须或可选接收哪些平台接口，不代表 Runtime 实际具备这些能力，也不固定具体 Skill/Tool 内容版本。DeploymentRoute 发布时要求 required 是 RuntimeRevision capabilities 的子集。

若 Agent 不支持某能力：

- 员工端选择器保持可见但禁用。
- 提示当前 Agent 的真实限制。
- 服务端再次校验，不能依靠 UI。

## 11. Execution Environment

Environment 是具体执行能力与强制策略的集合，包括：

- 文件系统视图。
- 命令和进程能力。
- 网络允许范围。
- 可用 Tool 与连接。
- Secret 注入方式。
- CPU、内存、时长和并发。
- 当前设备或 Runtime 状态。

### 11.1 Desktop

执行本地文件、Shell、Git、测试、浏览器和本机应用。平台权限建立在 OS 权限之上，不能因为当前用户可访问就自动把所有本机数据暴露给 Agent。

### 11.2 Cloud

执行云端 Workspace、长任务和平台 Tool。容器不能直接读取平台数据库或长期 Secret，外部访问经过 Gateway 与网络策略。

### 11.3 Remote

接入标准外部 Agent Runtime 或远程执行器。平台记录其协议能力、身份、网络区、事件和可恢复等级；任意裸 URL 不构成合格 Runtime。

### 11.4 Sandbox

执行 Agent 临时生成的不可信代码。默认不提供长期 Secret、宿主文件或任意网络，按任务限制资源并销毁。

## 12. Workspace

Workspace 是用户可见的默认位置，提供：

- 相对路径和默认搜索基准。
- Bash 默认工作目录。
- 未指定输出位置时的默认产物目录。
- Thread 的主要项目展示。

Workspace 不是 Execution Environment，也不是唯一访问目录。

### 12.1 选择与切换

- 新 Thread 可选择本地 Workspace、Cloud Workspace 或无 Workspace。
- 用户可以显式切换默认 Workspace。
- 切换产生 `workspace.changed` Event。
- 额外目录、文件或对象可以 attach，不要求切换默认 Workspace。
- 不做隐式文件迁移或双向同步。

### 12.2 位置优先级

~~~text
用户明确指定的位置
> 当前操作对象所在位置
> ToolCall 明确位置
> 当前任务临时目录
> Workspace 默认位置
~~~

业务例子：Thread 的 Workspace 在 Cloud，用户要求处理本地 Downloads/a.xlsx。本次输入和输出默认都在本地原目录，不能因为默认 Workspace 在云端就把结果写入 Cloud。

### 12.3 权限边界

普通跨目录读写是否执行，取决于用户意图、平台策略、数据敏感性、操作影响和 Environment，不取决于是否离开 Workspace。

- 读取另一个普通代码目录：通常允许并记录。
- 用户明确让 Agent 修改另一个项目：按正常代码修改策略执行。
- 读取浏览器 Cookie、SSH 私钥或其他敏感位置：阻止。
- 批量删除另一个目录：暂停确认。

## 13. Runtime、Revision 与 DeploymentRoute

Control Plane 管理 Agent 定义、Revision、部署、路由、策略和观测；Runtime 执行 Agent 代码，不拥有平台事实与治理权。

~~~mermaid
flowchart LR
  Agent --> AgentRevision
  Runtime --> RuntimeRevision
  AgentRevision --> Route["DeploymentRoute"]
  RuntimeRevision --> Route
  Route --> Invocation
~~~

多个员工和 Thread 可以共享同一逻辑 Runtime。DeploymentRoute 把 AgentRevision 路由到 RuntimeRevision；Invocation 启动时生成不可变 ExecutionBinding。新路由只影响新 Invocation，不替换已经运行的 Agent 代码和环境。

Workspace、Runtime 和 Sandbox 生命周期不同：

| 对象 | 生命周期 |
|---|---|
| Agent Runtime | 跟随 RuntimeRevision 和 DeploymentRoute |
| Thread / Workspace | 跟随用户任务 |
| Sandbox | 按不可信执行临时创建 |

发布回滚只把后续执行路由到旧 Revision，不撤销之前已经修改的文件、发送的消息或业务数据。

## 14. 验收检查

| 检查 | 通过条件 |
|---|---|
| Thread 是否被版本锁死 | 否；只保存默认位置与连续历史，实际执行版本写 ExecutionBinding，动态能力写 CapabilityUse |
| Thread 是否依赖 Agent 存在 | 否；Agent 目录为空也能创建 Thread 并执行，Agent 不是 Thread 存在前置 |
| Agent 约束是否可偷偷变化 | 否；Invocation 冻结的 Agent 约束不可变，变化必须显式交接 |
| Goal 是否强制 | 否；只有持续目标使用 |
| Tool 重试是否成为新 Turn | 否；进入当前 ToolCall/Effect 与 Trace，关键状态再投影为 Event |
| Item 与 Event 是否混为一表 | 否；Item 是当前内容，Event 是仅追加变化记录 |
| Attempt 是否表示每个 Loop 步骤 | 否；只表示真实基础设施重试 |
| Workspace 是否是权限边界 | 否；Environment 与平台策略才是强制边界 |
| Agent Revision 是否跟随 Skill 更新 | 否；只有 Agent 自身变化生成 |
| 管理员是否维护实际执行清单 | 否；平台自动生成只读记录 |
| VeADK 是否可直接读平台库和 Secret | 否；通过受控 Gateway |
