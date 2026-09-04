# 发布、观测与评测

## 1. 模块关系

~~~mermaid
flowchart LR
  Source["VeADK Agent 项目"] --> AgentRevision["AgentRevision"]
  Runtime["Runtime"] --> RuntimeRevision["RuntimeRevision"]
  AgentRevision --> Route["DeploymentRoute"]
  RuntimeRevision --> Route
  Route --> Invocation["Invocation / ExecutionBinding"]
  Invocation --> Thread["Thread / Turn / Item / Event"]
  Invocation --> Trace["Trace"]
  Trace --> Evaluation["Evaluation"]
  Trace --> Cost["成本与容量"]
  Route --> Admin["管理后台"]
  Trace --> Admin
  Evaluation --> Admin
  Cost --> Admin
~~~

发布决定“运行哪个 Agent 自身版本”；事件记录“用户任务发生了什么”；Trace 解释“内部怎么执行”；评测判断“结果是否正确和稳定”；审计记录“谁做了需要追责的操作”。

## 2. 发布边界

Agent 采用代码开发和普通项目交付，不在 重新发明一套 IDE、Git 或构建系统。VeADK Agent 仍在本地或公司标准开发环境中完成开发、测试和构建，再通过平台发布入口部署到托管 Runtime；不能把它描述成在云端后台页面直接开发。

SnowHarness 负责：

- Agent 项目登记与标准校验。
- 生成 SnowHarness Adapter。
- 关联构建制品、镜像摘要和来源 commit。
- 创建 Agent Revision。
- 管理 RuntimeRevision、DeploymentRoute、灰度、回滚和下线。
- 绑定访问范围、运行策略和评测门禁。
- 记录发布审计。

公司 CI/CD 负责：

- 拉取代码。
- 测试、构建与制品扫描。
- 镜像和 Artifact 管理。
- 基础设施部署。

两者的具体接口在公司系统对接时确定，本文不虚构。

## 3. 托管与外部 Runtime

### 3.1 托管

提交已经完成本地开发和测试的 VeADK 项目，或提交符合要求的镜像，由 SnowHarness 统一发布入口部署，获得完整的事件、Gateway、Trace、安全和恢复能力。火山 AgentKit 后台也应按“本地代码开发，云上发布和运行管理”理解；本方案参考的是部署后的管理范围，不把它当成云端可视化开发器。

### 3.2 外部

已部署服务通过标准 Agent Runtime Protocol 或 A2A 接入，必须说明：

- 身份和租户传递。
- 流式事件语义。
- Tool 和权限边界。
- 取消、超时和错误。
- Trace 传播。
- 可恢复能力。

只提供裸 URL 的服务可以作为普通远程 Tool，但不能被宣称为与托管 Agent 同等级的 Runtime。

### 3.3 能力等级

外部 Runtime 未暴露内部状态时，SnowHarness 只能观测请求、远端调用 ID、响应和超时，不能在本地精确恢复它的内部 Agent Loop。

## 4. AgentRevision、RuntimeRevision 与 DeploymentRoute

~~~mermaid
flowchart LR
  Agent --> AgentRevision
  Runtime --> RuntimeRevision
  AgentRevision --> Route["DeploymentRoute"]
  RuntimeRevision --> Route
  Route --> Invocation
~~~

AgentRevision 固定 Agent 自身代码、指令、模型策略、权限要求和制品。RuntimeRevision 固定托管制品或外部协议配置。DeploymentRoute 决定新 Invocation 使用哪一对修订及其 Scope、流量和优先级；Invocation 启动时写入不可变 ExecutionBinding。

普通 Skill、Tool 和 Knowledge 更新不生成 Agent Revision。实际内容在 Invocation/ToolCall 使用时解析并写入 CapabilityUse/ToolCall；Event 记录状态变化，Trace 记录诊断。

业务例子：风险审核 Agent 的 Prompt 修改后生成 Revision 7；它使用的法规 Skill 修正文案时仍是 Revision 7，但下一次加载记录新的 Skill hash。

## 5. 发布与回滚

- 已开始的 Invocation 继续使用其 ExecutionBinding。
- 新 Turn 或显式 Regenerate 创建的新 Invocation 使用当前 DeploymentRoute。
- 灰度可以按员工范围、环境或比例选择 Revision。
- 回滚只改变后续 Turn 的路由。
- 已发送邮件、已修改文件和已写业务系统的数据不会被发布回滚撤销。

高风险 Agent 可以配置发布门禁；普通内部助手可以采用基础构建检查与冒烟评测。门禁必须基于实际风险和业务要求，不要求所有 Agent 使用同一套阈值。

## 6. Runtime

Runtime 管理：

- Agent 实例、健康和版本。
- CPU、内存、并发和冷启动。
- 网络出口和受控 Gateway。
- Environment 与 Sandbox 连接。
- 事件与 Trace 传播。
- 配置引用和非敏感环境参数。

Runtime 不能直接：

- 读取 SnowHarness 平台数据库。
- 持有长期 Credential 原值。
- 绕过 Tool Gateway 访问企业系统。
- 把另一个租户的上下文放入当前请求。

一个 RuntimeRevision 可以有多个弹性实例；一个实例也可以在隔离条件下并发处理多个 Invocation。产品上不把容器实例暴露成 Agent。

## 7. Trace 模型

Trace 以 Invocation 为主要根节点；Turn、Child Thread 和 Job 通过 id 聚合多个 Trace：

~~~text
Thread
├─ Turn A
│  ├─ Invocation 1 → Trace A1
│  └─ Regenerate Invocation 2 → Trace A2
├─ Turn B → Invocation 3 → Trace B
└─ Child Thread
   └─ Turn C → Invocation 4 → Trace C
~~~

Thread 使用稳定 session/thread 标识聚合多个 Trace，不创建一个永不结束的大 Trace。Child Thread 使用独立 Trace，通过 parent link 与委派事件关联。

Trace 下的 Observation 至少包括：

- Agent Loop 决策。
- Model Call。
- Skill 加载。
- ToolCall 与 ToolResult。
- Knowledge 与 Memory 检索。
- Desktop、Browser、Bash、Workspace 和 Sandbox。
- Child Thread 创建与结果。
- 权限、安全与等待用户操作。

## 8. 业务事件与 Trace 分开

| 数据 | 作用 | 是否业务事实源 |
|---|---|---|
| Thread / Turn / Item / ThreadEvent / JobEvent | 当前内容、交互与后台状态变化、审批、Artifact 和交接 | 是 |
| ToolCall / Effect / Permission | 工具执行、外部副作用核对和权限决定 | 是 |
| Trace / Observation | 调用结构、耗时、Token、费用、错误和技术引用 | 否 |
| Log | 服务与 Agent 排错 | 否 |
| Audit Event | 发布、授权、高风险操作、查看和导出 | 是，且不可修改 |
| Evaluation Result | 质量与策略评估 | 否 |

Trace 丢失不能把一个已成功 ToolCall 变成失败；Item、Event 和 ToolCall/Effect 决定实际状态。Trace 可以从事件和遥测重建部分结构，但不反向修改业务事实。

## 9. 默认观测内容

撤回 full_redacted 作为全平台默认。默认采集结构化元数据：

- Agent Revision、模型和参数。
- Skill 标识与内容 hash。
- Tool 标识、Schema hash、执行器和 operation_id。
- Knowledge、Memory 与文件引用。
- 权限、安全和 Credential 引用。
- 状态、耗时、Token、费用和错误。
- Event、Thread、Turn 与 parent link。

内容采集按策略：

| 模式 | 内容 | 适用 |
|---|---|---|
| metadata | 结构、hash、用量、状态和错误 | 普通生产默认 |
| redacted | 脱敏后的 Prompt、响应、Tool 参数和结果 | 允许内容排障的 Agent |
| diagnostic | 指定 Agent、环境、有效期内更完整的脱敏内容 | 事故诊断和评测 |

策略由租户、Environment、数据分类、Agent 和诊断开关共同决定。管理员不能因为需要排障就绕过数据保留和访问策略。

永不采集：

- API Key、OAuth Token、Cookie 值、密码、验证码和私钥。
- 系统注入的 Secret。
- 模型供应商未返回的隐藏思维链。

## 10. 管理后台运行详情

管理员从 Thread 进入 Turn 详情：

~~~text
Turn 概览
├─ 用户消息与正式回答
├─ Agent Revision、模型、Environment
├─ 状态、耗时、Token、费用
├─ 事件时间线
├─ Trace 调用树
├─ Tool / Skill / Knowledge / Memory
├─ Child Thread
├─ Artifact 与文件变化
├─ 权限、审批和安全
└─ 日志与审计
~~~

点击 Observation 显示：

- 实际输入输出的可用级别。
- 内容引用和 hash。
- Tool Schema 与参数摘要。
- 执行位置和连接。
- 重试、超时、取消和 effect status。
- 上下游关系。

查看和导出 redacted/diagnostic 内容必须产生审计。

## 11. 观测完整性

每个 Invocation 必须有结构化 Trace，不对调用结构抽样；Turn 通过 Invocation id 聚合。内容是否采集由策略决定。

需要监测：

- 事件与 Trace 是否成功关联。
- parent link 是否断裂。
- ToolCall 是否缺少 ToolResult 或 effect status。
- Skill/Schema hash 是否缺失。
- Desktop 与 Cloud Trace 是否贯通。
- Trace 上传积压和丢失。

观测组件暂时不可用时，业务事件和 Tool 结果仍要持久化；遥测进入本地或平台可靠队列补传。

## 12. Evaluation

评测回答“Agent 做得是否正确、稳定和经济”，不能只看最终文字。

评测复用正常 Runtime、Tool 实现、Event 和 Trace：

~~~text
Eval Experiment
→ 正常 Agent Revision 与 Runtime
→ 测试 Environment
→ Turn / Invocation / Item / Event / Trace
→ Evaluator
→ Result
~~~

评测禁止连接生产系统，也不能用和生产完全不同的假 Tool 或内存实现替代真实路径。应使用同构测试环境、隔离 Workspace 与 Sandbox。

## 13. 评测集

来源：

1. 人工创建问题、预期结论、Tool、禁止操作和测试文件。
2. CSV 等批量导入。
3. 从真实 Turn 脱敏转入，再由人工修正预期。
4. 从制度、标准问答和工单生成候选，再审核。

真实 Agent 回答不能未经审核就当成正确答案。评测集和用例使用版本化内容；已用于实验的版本不可原地修改。

## 14. 评估器

| 类型 | 检查内容 |
|---|---|
| Deterministic | JSON、数值、文件、测试、业务状态、禁止操作 |
| Trajectory | Tool 选择、参数、必要步骤、顺序和副作用 |
| LLM | 相关性、完整性、事实一致性和表达 |
| Human | 高价值案例复核与模型评分校准 |
| Context | 约束、决定、压缩、Memory 与 Knowledge |
| Security | 权限、审批、外发和风险变化 |

确定性检查优先。财务金额、数据库结果和外部系统状态不能只由另一个模型评分。

## 15. 对比实验

一次离线实验固定：

- 评测集版本。
- Agent Revision。
- 模型和参数。
- 需要固定的 Skill / Tool Contract。
- Knowledge 测试快照。
- Workspace、测试文件和业务系统数据基线。
- Evaluator 版本。

比较维度：

- 最终结果和逐条得分。
- Tool 轨迹和副作用。
- 失败 Trace。
- Token、耗时和费用。
- 基线与候选差异。

普通生产 Thread 的实时 Knowledge 和 Workspace 会变化，因此线上 Trace 可解释当时事实，但不承诺数月后原样重现。

## 16. 能力变化评测

平台按风险差异决定：

| 变化 | 默认评测 |
|---|---|
| Skill 文案修正 | 不触发所有 Agent 回归 |
| Tool 描述改进 | 不触发所有 Agent 回归 |
| 新增只读可选参数 | 运行 Tool Contract 检查 |
| 只读变写入 | 安全与轨迹评测 |
| 新增 Credential / 网络 | 安全、数据外发和连接评测 |
| 新增不可逆副作用 | 幂等、审批、核对和补偿评测 |
| Agent Revision | 按该 Agent Release Gate |

平台从实际使用事件找出受影响 Agent 和 Job，为高风险变化选择相关评测集；不把任务转嫁给所有 Agent 管理员。

## 17. 线上评估

从真实 Thread、Turn 或 Trace 按 Agent、时间、结果、用户范围和风险筛选，支持：

- 随机抽样。
- 百分比抽样。
- 全量检查指定规则。
- 按失败、成本、授权或 Tool 筛选。
- 人工标注与申诉。

线上评估引用现有事实，不复制一套运行数据库。

## 18. 成本与用量

至少按以下维度归集：

- 租户、部门、用户。
- Agent 与 Revision。
- Thread、Goal、Turn、Child Thread 和 Job。
- 模型、Tool、Knowledge、Sandbox 和 Environment。

指标：

- 输入/输出 Token 与费用。
- 模型与 Tool 调用次数。
- 排队、运行和等待时间。
- Child Thread 数和并发。
- Sandbox、Desktop 与 Runtime 资源。
- 失败、重试、取消和预算耗尽。

成本投影来自事件与 Trace，不修改业务状态。

## 最终执行与恢复边界

- `tool.call` 必须由生产 Harness 工厂装配并经过 Capability Catalog、Policy 与可信 Subject 校验。
- Runtime Start 请求体不接受 Subject；Subject 只从服务端认证 Principal 冻结到 ExecutionBinding，恢复时重新读取该 Binding。
- `invocation_continuation` 由业务事务写入 Control Plane Outbox，Worker 读取后恢复原 Invocation；内存事件不能作为恢复事实。
- Hosted `handleResume` 必须继续运行原 Harness Loop；未知 Invocation 明确失败，不能只返回 ACK。

## 19. 容量

组件分工：

| 组件 | 职责 |
|---|---|
| Runtime Capacity Provider | Agent 实例、扩缩容、冷启动 |
| Model Gateway | RPM/TPM、路由、限流和允许的 fallback |
| Tool Gateway | Tool 并发、超时、连接和执行器 |
| Sandbox Manager | 隔离资源与排队 |
| Desktop Executor | 设备在线、Slot、版本和本地锁 |
| Durable Workflow | 长任务和后台任务的可靠调度 |
| SnowHarness | 状态、策略、用量、告警和审计 |

Slot 分开计算：

~~~text
Turn Slot
Model Call Slot
Tool Call Slot
Sandbox Slot
Desktop Slot
~~~

不能只靠 CPU 判断扩容，还要看积压、最老等待时间、冷启动、模型限流和外部系统容量。

## 20. 调度

- interactive、background、maintenance 使用不同优先级。
- 普通用户不能自行设为最高优先级。
- 同级任务按用户或部门公平调度。
- Child Thread 继承父任务优先级和预算。
- Desktop 离线、Workspace 写锁和模型限流显示真实原因。
- 确定性错误直接失败，不放进队列无限等待。

## 21. 告警

需要覆盖：

- Agent Revision 发布或 Runtime 健康异常。
- 错误率、P95 延迟和成本异常。
- Tool Schema hash 缺失或调用失败。
- Trace 断点与事件积压。
- 高风险能力变化待审核。
- Credential 即将过期或认证失败。
- Desktop 大面积离线。
- Sandbox、模型或 Runtime 容量不足。
- 评测门禁失败和线上质量下降。

## 22. 保留与删除

分别配置：

- Thread 与业务消息。
- Event。
- Trace 元数据。
- redacted/diagnostic 内容。
- Log。
- Artifact。
- Audit。
- Evaluation。

删除必须同步处理索引、缓存和引用。Audit 与依法必须保留的数据按组织策略执行；不能因为清理 Trace 把业务副作用事实一并删除。

## 23. 验收检查

| 检查 | 通过条件 |
|---|---|
| 每次 Skill/Tool 更新是否生成 Agent Revision | 否 |
| 每个 Attempt 是否是产品必需对象 | 否；只有真实基础设施重试才按需物化 Attempt，并进入 Trace |
| full_redacted 是否全平台默认 | 否，默认 metadata，内容按策略 |
| Trace 是否是业务事实源 | 否；Item、Event 与 ToolCall/Effect 才决定业务状态 |
| 管理员是否能看到 Credential 原值 | 不能 |
| 评测是否使用假执行器 | 否，使用同构测试环境 |
| 普通能力变化是否跑全量 Agent 回归 | 否，按风险和实际影响针对性评测 |
| 回滚是否撤销旧副作用 | 否 |
| 管理后台是否能从 Thread 查到实际 hash 和权限 | 能 |
