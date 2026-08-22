# 连续性、协作与可靠执行

## 1. 可靠性的分层

不把所有交互都包装成 Temporal Workflow，也不把可靠性简化成“失败后从头再跑”。

| 场景 | 主要机制 |
|---|---|
| 普通聊天与短工具调用 | 持久事件、ToolCall 记录、局部状态、断点续读 |
| 文件和代码任务 | 事件、文件 hash、diff、Git/worktree 或 Workspace Checkpoint |
| 有副作用的外部操作 | operation_id、Effect Ledger、结果核对、补偿 |
| 等待用户登录或确认 | 可持久化 UserActionRequest |
| Child Thread | 独立事件、状态和结构化交接 |
| 定时、批量、跨天、跨服务任务 | Temporal 等 Durable Workflow |

员工端统一看到 Thread、Turn、Item 和 Event；Invocation、Attempt 或 Workflow 是内部执行细节。

## 2. 事件连续性

每个 Thread 的事件按稳定序号仅追加：

~~~text
event 101  tool_call.started
event 102  user_action.requested
event 103  user_action.resolved
event 104  tool_call.succeeded
event 105  item.completed
event 106  turn.completed
~~~

客户端断线不改变 Turn 状态。重新连接时从最后序号读取，恢复：

- 当前持久 Item；本次连接的临时增量不保证重放。
- ToolCall 与结果。
- 等待确认、登录或输入。
- Child Thread 状态。
- Artifact 和文件变化。
- 中断、错误与完成状态。

推送丢失不能导致业务事件丢失。所有面向员工的关键状态先持久化再通知。

## 3. Resume

Resume（恢复会话）读取：

- Thread（连续工作容器，不保存主 Agent 身份）。
- 最近 Turn 和事件。
- PendingInput。
- 当前等待的 UserActionRequest。
- 最新可用 Context Checkpoint。
- Workspace、Environment 与设备状态。
- 未完成 ToolCall 和 effect status。

如果执行状态可确定，Agent Loop 从下一安全决策点继续；若外部副作用结果未知，必须先核对，不能直接重放。

业务例子：Desktop 在本地测试运行时断电。恢复后平台先确认测试进程已结束、文件 hash 和 diff 是否变化，再决定重跑测试；不会重新执行之前已经成功的代码修改。

## 4. Fork

Fork 从指定 Turn 创建新 Thread：

- 复制到该 Turn 为止的用户可见历史与必要事件引用。
- 新 Thread 获得独立 Goal、Workspace 和后续事件（不复制主 Agent 身份；Thread 不保存主 Agent）。
- 父 Thread 不受分支变化影响。
- Fork 记录来源 Thread 和 Turn。

Fork 适合：

- 比较两种 Agent 或模型方案。
- 从旧决策点尝试另一条路径。
- 把探索任务与正式任务分开。

业务例子：用户在数据库方案讨论后 Fork 两个 Thread，分别验证 PostgreSQL 和 MySQL；两个分支不会共享后续决定和文件写入。

## 5. 运行中输入

### 5.1 PendingInput 队列

Turn 运行中，普通新输入先进入 PendingInput：

- 可以编辑。
- 可以删除。
- 可以排序。
- 尚未正式发送时不是 UserMessage，不进入上下文。

当前 Turn 正常结束后，队首输入创建下一 Turn。

### 5.2 Steer / 引导

用户选择“引导”：

1. 选中输入先以 pending user_guidance Item 加入当前 Turn，并记录 `turn.steer_queued`。
2. 平台向 Runtime 发送持久 steer command；正在进行的不可安全中断 ToolCall先完成或进入可取消状态。
3. `next_safe_point` 保留当前生成；只有 `interrupt_generation` 且 Runtime 确认实际中断时，未完成生成才进入 interrupted/superseded。
4. Runtime 在安全点 ack 后，Item 才完成并记录 `turn.steered`；拒绝或不支持则把 command/Item 标记 failed。
5. Agent Loop 在下一个决策点读取新要求，员工端随后显示“已引导本次对话”。

waiting_user 必须解析对应 UserActionRequest，不能用 Steer 绕过确认、登录或授权。Agent 约束、Environment 或高风险能力变化需要显式配置事件；不能把带隐式扩权的输入直接注入正在执行的 ToolCall。

### 5.3 Stop / 停止

停止只中断当前 Turn：

- 阻止创建新的行动。
- 请求取消当前模型或 Tool。
- 保留已完成事件和副作用。
- 暂停 PendingInput 队列。
- 不自动发送下一条。

停止不承诺撤销已经写入的文件、发送的消息或业务系统变更。

## 6. 重试与重新生成

### 6.1 用户消息唯一

一条正式用户消息在默认会话视图中只有一份。重新生成通过新的 Invocation、新 agent_message Item 和 Event 建立回答分支：

~~~text
Turn
├─ UserMessage: 你好
├─ Invocation A: network_failed
├─ Invocation B: AgentResponse 旧回答，superseded
└─ Invocation C: AgentResponse 当前回答
~~~

普通 UI 只显示 UserMessage 和当前回答，后台可以查看分支。

### 6.2 失败前没有副作用

单个模型供应商请求重试保留在同一 Model Span；只有 Worker 失联、Runtime 重连或检查点恢复导致整个 Invocation 重新调度时才增加 Attempt。业务重新生成则创建新 Invocation。它们都不能复制 user_message Item。

### 6.3 已经存在回答

旧回答标记为 superseded，不再进入默认上下文；新回答成为当前采用版本。

### 6.4 已经产生副作用

默认复用已确认结果，只重新生成后续解释或汇总。用户明确要求完整重做时，平台先列出已发生操作并重新确认不可重复部分。

业务例子：第一次生成已经成功发送邮件，只是最终总结页面断线。重新生成只读取 send_email 的 confirmed_success 结果，不再发送第二封邮件。

## 7. ToolCall 可靠性

每个可能产生副作用的调用保存稳定 operation_id：

| 状态 | 含义 | 后续处理 |
|---|---|---|
| not_started | 目标系统未收到 | 可以执行 |
| confirmed_success | 目标系统确认成功 | 复用结果 |
| confirmed_partial | 多目标操作部分成功且已确定 | 保留逐目标结果，只重试明确失败且安全的目标 |
| confirmed_failure | 明确失败且未产生影响 | 按策略重试 |
| unknown_effect | 请求可能生效但结果不明 | 核对或人工处理 |

执行中状态属于 ToolCall，不属于最终 EffectRecord。补偿是新的、单独授权的 ToolCall，通过 causation_id 关联原操作，不能改写原副作用事实。

超时不等于失败。平台优先使用目标系统的幂等键、查询接口、业务单号或回调确认实际状态。

业务例子：报销提交超时后，先按 operation_id 查询是否已生成报销单。存在则返回单号；不存在且服务确认未处理才重试；无法查询时暂停，不能创建第二张单。

## 8. Checkpoint

Checkpoint 是选择性恢复信息，不是每个模型调用的完整上下文复制。

### 8.1 会话 Checkpoint

记录目标、约束、决定、当前状态、未完成事项和事件引用，支撑长会话压缩与恢复。

### 8.2 Workspace Checkpoint

根据实际环境选择：

- Git commit、branch、worktree 和 diff。
- 文件 hash、变更清单和 Artifact。
- Cloud Workspace Snapshot。
- 数据处理的中间结果与输入修订。

Desktop 本地内容不为恢复方便自动上传 Cloud。

### 8.3 Workflow Checkpoint

只用于长任务的外部等待、跨服务进度、定时状态和补偿点。

Checkpoint 写入失败时，如果下一步将产生不可重复副作用，必须暂停；纯读取和可安全重算步骤可以按策略继续。

## 9. Child Thread

多智能体默认使用独立 Child Thread：

~~~mermaid
flowchart TB
  Parent["Parent Thread<br/>主导 Agent 与用户交互"]
  Parent --> A["Child Thread A<br/>资料检索"]
  Parent --> B["Child Thread B<br/>数据分析"]
  Parent --> C["Child Thread C<br/>风险审核"]
  A --> Result["结构化结果 / Artifact / Trace 引用"]
  B --> Result
  C --> Result
  Result --> Parent
~~~

Child Thread 拥有：

- 独立 Agent 与 Revision。
- 独立上下文、事件和 Trace。
- 独立权限判断和 Environment。
- 继承但受限的预算。
- 父 Thread、委派任务和结果关系。

父 Agent 不把整个 Thread、内部 Prompt 和全部 Memory 无差别复制给子 Agent。

## 10. Context Handoff

父 Thread 传给 Child Thread：

~~~yaml
objective:
success_criteria:
constraints:
required_background:
resource_refs:
allowed_capabilities:
workspace_access:
budget:
expected_output:
~~~

默认只传 task_only；需要连续上下文时使用 recent；full 必须有明确理由和权限。Child Thread 返回：

- 状态与结论。
- 结构化输出。
- Artifact 引用。
- 已发生副作用。
- 未解决问题和错误。
- 成本、耗时和 Trace 引用。

业务例子：对话主导 Agent 委派图表 Agent，只传清洗后的数据 Artifact、图表要求和品牌规范，不传财务系统 Credential 或整段会话。

## 11. 协作语义

| 语义 | 行为 |
|---|---|
| Delegate | 对话主导 Agent 委派明确子任务并等待结果 |
| Parallel | 多个 Child Thread 并行，对话主导 Agent 汇总 |
| Handoff | 显式把主责交给另一个 Agent |
| Agent-as-Tool | 受限调用一个 Agent 能力，返回单次结果 |
| Workflow Agent | 固定顺序、并行、循环写入 Agent Harness 配置 |
| A2A | 外部 Agent 保持独立身份、协议和会话 |

并非所有协作都强制投影成 ChildRun。Child Thread 是默认会话协作单位；固定工作流可以使用 Workflow，简单受限能力可以 Agent-as-Tool。

## 12. Handoff

Handoff 必须：

- 展示原主导 Agent 与新主导 Agent（交接语义属后续 Agent 调用专题）。
- 记录原因、上下文范围和权限变化。
- 明确谁负责下一次用户交互。
- 保留旧 Agent 的结果与未完成事项。
- 不因交接自动扩大 Workspace、Memory 或 Tool 权限。

用户显式选择另一个 Agent继续当前 Thread 时，也走同一交接语义。

## 13. 并发 Workspace

多个 Child Thread 并发操作文件：

- Cloud Workspace 使用 Overlay 或独立写层。
- Git 工程使用 worktree 或等价隔离。
- Desktop 对同一路径使用写锁。
- 只读任务可以共享同一文件修订。
- 合并冲突显式报告，不能后完成者静默覆盖。

业务例子：两个子 Agent 分别修改前端和后端时使用两个 worktree；汇总前运行合并和测试。若都修改同一配置，对话主导 Agent 收到冲突而不是自动覆盖。

## 14. Temporal / Durable Workflow

### 14.1 使用条件

满足一个或多个条件时使用：

- 等待可能持续数分钟、数小时或数天。
- 跨多个服务并需要持久状态。
- 无人值守、定时或批量执行。
- 必须在 Worker 重启后精确恢复。
- 存在明确补偿和重试流程。
- 部署、评测或知识构建等后台任务。

### 14.2 不使用的默认场景

- 一次普通模型调用。
- 短时只读 ToolCall。
- 普通聊天回答。
- 可由事件和局部结果恢复的本地编辑。

### 14.3 对外产品模型

即使底层使用 Temporal：

- 员工看到 Thread、Turn、Item、等待原因和 Event。
- 管理后台可以展开 Workflow 和 Activity 诊断。
- Workflow 状态不替代业务事件。

## 15. Job / Invocation

定时、批量、部署和无人值守任务使用 Job：

~~~text
Job Definition
└─ Invocation
   ├─ Agent Revision / 固定能力策略
   ├─ 输入与触发器
   ├─ Durable Workflow
   ├─ JobEvent 与 Trace
   └─ 结果与 Artifact
~~~

Job 不是普通聊天的包装。它使用独立 JobEvent；可以关联 Thread 供人工接管，但只有显式在已有来源 Turn 创建结果投影 Item，或先创建 system-triggered Turn 后，结果才进入员工会话 ThreadEvent。

业务例子：每天 8 点生成经营日报是 Job Invocation；员工临时问“昨天销售额多少”是普通 Turn。

## 16. 取消

取消流程：

1. 记录 interrupt/cancel_requested。
2. 阻止新的模型决策和 ToolCall。
3. 通知当前模型、Tool、Child Thread 或 Workflow。
4. 撤销尚未使用的临时授权和 Lease。
5. 等待不可安全中断的副作用进入确定状态。
6. 丢弃迟到的 UI 增量，但保留迟到结果用于审计和 effect 核对。
7. 记录最终 interrupted/cancelled。

取消不能把已完成副作用伪装成未发生。

## 17. 调度与资源可靠性

PendingInput 队列只负责同一 Thread 的交互顺序；平台调度队列负责执行容量。两者不能混在一起。

平台按执行目标管理：

- Runtime Slot。
- Model Call Slot。
- Tool Call Slot。
- Sandbox Slot。
- Desktop Device Slot。
- Workspace 写锁。

确定性问题直接失败，例如 Agent 已禁用、权限拒绝或输入无效。临时问题进入等待或队列，例如 Runtime 冷启动、模型限流、Desktop 离线或 Sandbox 容量不足。

员工端显示真实原因，不承诺不可靠的精确队列名次。

## 18. 预算

普通 Turn、Goal、Child Thread 和 Job 都受可配置预算约束：

- 时长、Token 和费用。
- 模型与 Tool 调用次数。
- Child Thread 数、深度和并发。
- Sandbox 时间与资源。
- 输出和 Artifact 大小。

Child Thread 共享父任务总预算，不能通过不断委派绕过限制。预算到达硬上限时阻止新行动；正在执行副作用的 ToolCall 先进入结果核对，不能粗暴杀死后当成失败重试。

## 19. 验收检查

| 检查 | 通过条件 |
|---|---|
| 普通 Turn 是否必须进 Temporal | 否 |
| 断线是否丢进度 | 否，按事件序号续读 |
| 重试是否复制用户消息 | 否 |
| 重试是否重复已完成副作用 | 否，复用 confirmed_success |
| 超时是否直接重发 | 否，先核对 effect |
| 子 Agent 是否共享全部父上下文 | 否，使用结构化 Handoff |
| 多智能体是否只有 ChildRun 一种表示 | 否，默认 Child Thread，另有 Workflow、Agent-as-Tool 和 A2A |
| Desktop 文件是否为恢复自动上传 Cloud | 否 |
| Stop 是否自动发送队列下一条 | 否 |
