# 产品入口与管理后台

## 1. 产品边界

只有一个 SnowHarness 产品，提供三个入口：

~~~mermaid
flowchart LR
  Employee["员工"]
  AdminUser["管理员 / Agent 负责人 / 安全运营"]
  Employee --> Desktop["Desktop 客户端<br/>云端任务 + 本地增强"]
  Employee --> Web["Web 员工端<br/>云端任务"]
  AdminUser --> Admin["Web 管理后台"]
  Desktop --> Platform["SnowHarness Platform"]
  Web --> Platform
  Admin --> Platform
~~~

用户之前所说的“员工端”就是 Desktop 客户端与 Web 员工端；“管理员登录”进入 SnowHarness 统一管理后台，用于管理 Agent 的部署、Skill、Tool、知识、Runtime、观测、评测、安全、成本和容量。后台建设范围参考火山 AgentKit 部署后的成熟管理能力，但按公司员工使用端、Desktop 本地资源和内部系统操作场景重新组织。

三端不是三个独立系统：

- Agent、Thread、组织身份、访问范围和平台策略共用。
- Desktop 和 Web 可以进入同一个 Thread。
- 管理后台从同一事件事实与 Trace 排障，不另建一套运行记录。
- Desktop 与 Web 都可以处理云端任务。Desktop 额外连接本地项目、文件、浏览器登录态、本机应用和本地执行环境，能力范围更完整。
- Desktop 与 Web 的区别主要是可连接的执行环境，不是会话模型或云端能力不同。

业务例子：员工可以在 Web 或 Desktop 发起“整理季度经营数据”，两边都能查询云端数据。晚上在 Desktop 打开同一 Thread 并追加本地 Excel 后，后台看到的是同一会话中的云端查询和本地文件处理，不是两项任务。

## 2. 员工 Desktop

Desktop 覆盖 Web 的云端任务能力，并在此基础上处理需要本地资源或本机登录态的复杂任务，主要提供：

- Agent、模型和 Skill 的选择入口。
- Cloud Workspace、知识和业务系统 Tool。
- 本地项目、文件与目录选择。
- 本地 Shell、Git、测试、构建和应用预览能力。
- 浏览器登录态与本机应用连接。
- Desktop Executor 的在线状态、权限和任务进度。
- 本地 Artifact 的打开、定位和变更预览。
- 等待登录、确认、系统授权时的原生交互。

Desktop 不自行实现另一套 Agent Loop。它订阅平台 Thread/Event，执行平台允许且路由到本机的操作，再把结构化结果和实际影响写回事件流。

业务例子：代码审查 Agent 需要运行本地测试。Agent Loop 产生 command ToolCall，平台确认是普通测试后路由到 Desktop；Desktop 在当前 Environment 执行并返回退出码、日志摘要和 Artifact。

### 2.1 Desktop 目标形态：任务操作台

Desktop 的目标不是让员工在 SnowHarness 和多个内部系统之间反复切换，而是把完成任务需要的查询、填写、确认和提交放进同一项任务：

- 右侧任务面板可以打开当前任务涉及的内部系统，并复用员工已经授权的浏览器登录态。
- Agent 可以定位页面、查询数据、填写表单和准备提交内容；页面操作过程与结果写回当前 Thread。
- 目标系统有稳定、受控的接口时，优先通过 Tool Gateway 调用接口，不要求为了“看得见”而打开页面。
- 只读查询和明确授权的低风险操作可以直接执行；发送、提交、付款、删除等高影响操作必须展示具体影响并等待员工确认。
- 页面或接口返回不明确时，先核对目标系统状态，不能因为超时而重复提交。

业务例子：员工要求“根据发票和差旅制度提交报销”。Agent 先读取本地发票和制度，再通过接口查询可用报销项目；需要员工确认时，Desktop 右侧打开报销系统并展示已填写内容。员工确认后提交，报销单号、文件变化和实际影响继续记录在原 Thread 中。

## 3. 员工 Web

Web 员工端面向云端和跨设备任务。它与 Desktop 使用相同的 Agent、会话和云端执行能力，主要提供：

- Agent 目录和 Thread 管理。
- Cloud Workspace 与云端 Artifact。
- 业务系统 Tool、Knowledge 和 Memory。
- Turn 事件时间线、文件、审批和子智能体进度。
- PendingInput 队列、引导、停止、恢复与分叉。
- 从其他设备继续不依赖本机资源的任务。

Web 不能伪装成本地执行。本地文件或本机浏览器任务只有在已连接 Desktop Environment 时才能继续；设备离线时应等待或让用户明确改变执行方案。

业务例子：用户在 Web Thread 中要求处理 Downloads/a.xlsx。若 Desktop 在线，文件读取和输出仍在本地原目录；若 Desktop 离线，界面显示“等待该设备”，不能把文件任务静默改到 Cloud Workspace。

## 4. 员工端统一任务界面

员工端主界面围绕 Thread，而不是围绕 Run 表单：

~~~text
Thread 标题
├─ 可选 Goal 与任务状态
├─ 事件时间线
│  ├─ 用户与 Agent 消息
│  ├─ 公开工作进度
│  ├─ Tool / 文件 / Artifact
│  ├─ 等待确认或登录
│  └─ Child Thread
├─ 输入区
│  ├─ Agent
│  ├─ 模型
│  ├─ Skill
│  ├─ Workspace / Environment
│  └─ 发送 / 引导 / 停止
└─ PendingInput 队列
~~~

Desktop 在同一任务界面右侧增加任务操作面板：可以展示文件或页面结果，也可以打开内部系统完成查询、填写、确认和提交。接口可用时不强制打开页面；需要本地登录态或页面交互时，动作路由到 Desktop Environment。

Agent 与 Skill 选择器放在同一输入区域。模型、Skill 和执行位置可以按任务调整。Agent 目录为空时选择器显示"还没有智能体"，但不阻止创建 Thread 或发送 Turn。某个 Agent Revision 不支持模型替换或动态 Skill 时，控件保持可见但禁用，并用中文说明原因。

Preview 已属于 Harness 面板能力，不再作为 Agent 独立产品功能。员工侧的项目部署与 Git 交付不属于本方案；管理员对 Agent Runtime 的发布部署仍属于平台能力。

## 5. 员工端关键交互

### 5.1 创建 Thread

用户可以只输入标题、选择默认 Workspace 或直接发送消息。平台创建 Thread，保存默认位置与连续历史；创建 Thread 不要求、也不保存任何主 Agent 身份（Agent 目录为空仍可创建）。

### 5.2 切换模型

切换模型不会清空历史。当前 Invocation 继续使用 ExecutionBinding 中的模型；选择结果写入 Thread.default_model_ref，对下一次新 Invocation 生效，同时记录 `thread.model_changed` Event 及来源。

业务例子：用户发现当前模型不能识别图片，选择视觉模型继续提问。Thread、文件和已确认约束不变。

### 5.3 更换 Agent 约束（后续专题）

专题 01 已移除 Thread 上的主 Agent 身份与 `change-primary-agent`：Thread 不保存主 Agent。用户在某个 Turn/Invocation 偏好某 Agent、Agent 交接（handoff）与调用规划的语义由后续 Agent 调用专题定义；届时在该专题约束下实现显式交接，专题 01 不提前定义。

### 5.4 运行中发送消息

- 默认发送：进入 PendingInput 队列。
- 编辑：只修改尚未正式发送的输入。
- 删除：从队列移除，不产生 UserMessage。
- 排序：调整后续正式发送顺序。
- 引导：默认在下一安全决策点把输入注入当前 Turn；只有员工选择中断生成模式且 Runtime 确认后才停止未完成生成，ack 后显示“已引导本次对话”。
- 停止：中断当前 Turn，暂停队列，不自动发送下一条。

携带 Agent 约束、执行环境或高影响能力变化的输入不能隐式注入当前行动；平台应明确结束当前行动后再采用新配置。

### 5.5 重试与重新生成

最后一条正式用户消息在 Thread 中只有一份。用户点击重试：

- 若没有回答，重新开始该 Turn 的生成分支。
- 若已有回答，旧回答标记为被替代并从默认聊天视图移除。
- 后台保留旧分支和原因，用于排障与比较。
- 已确认完成的外部副作用不自动重复执行。

业务例子：用户发送“你好”，网络失败后连点三次重试，聊天记录仍只有一条“你好”和当前采用的一条回答。

## 6. Agent 目录与使用范围

SnowHarness 不建设带购买、评分和营销能力的应用市场，只提供内部 Agent 目录。

Agent 默认全员可用，也可以限制到：

- 部门。
- 用户组。
- 岗位或角色。
- 指定用户。

同一份使用范围同时用于员工端展示和服务端使用校验，不能只靠前端隐藏。内部测试通过收窄范围完成，不增加“测试中”生命周期。Agent 的 enabled 只表示是否允许创建新任务，Revision 的发布状态只表示是否可执行。

管理员把共享 Knowledge 或 Tool 装配给 Agent，并把 Agent 开放给某批员工，构成通过该 Agent 使用共享资源的明确授权；不再拿员工部门与资源部门做机械求交。租户隔离、资源撤销、个人连接和下游系统本人数据权限仍由平台强制。

业务例子：报销制度 Agent 对全员开放并使用财务部门维护的制度库。员工可以查制度，但“查询我的报销单”仍使用员工自己的系统身份，只能看到本人数据。

## 7. 管理后台角色

角色只描述职责，最终组织字段和授权接口另行设计：

| 角色 | 主要任务 |
|---|---|
| 平台管理员 | 平台设置、组织、模型、Runtime、配额、基础设施 |
| Agent 负责人 | Agent Revision、访问范围、部署、评测和运行质量 |
| 能力负责人 | Skill、Tool、Knowledge、来源、变更和使用分析 |
| 安全管理员 | 策略、风险变化、Credential、审批、安全事件和审计 |
| 运营与评测人员 | Thread 抽样、Trace、评测集、实验、质量与成本分析 |
| 只读排障人员 | 在授权范围内查看结构化 Trace 和脱敏内容 |

查看或导出诊断内容本身必须审计。超级管理员也不能在观测页面看到 Credential 原值。

## 8. 管理后台信息架构

~~~text
智能体
├─ Agent 目录
├─ Revision 与变更
├─ 访问范围
├─ 发布与部署
└─ 使用与质量

能力与知识
├─ Skill
├─ Tool
├─ Knowledge Base
├─ 知识图谱
├─ 模型
└─ 连接

会话与协作
├─ Thread / Turn / Item
├─ Child Thread / Handoff
└─ 等待用户操作

运行与环境
├─ Invocation / Job
├─ Runtime / RuntimeRevision / DeploymentRoute
├─ Desktop / Cloud / Remote
├─ Sandbox
└─ 队列与容量

观测与评测
├─ 事件时间线
├─ Trace
├─ 日志
├─ 评测集与实验
├─ 线上评估
└─ 成本与用量

安全与审计
├─ 安全策略
├─ 风险变化
├─ 审批与授权
├─ Credential 诊断
├─ 安全事件
└─ 审计

平台设置
├─ 组织与租户
├─ 模型与供应商
├─ Runtime 与基础设施
├─ 配额与保留策略
└─ 公司系统接入
~~~

“能力与知识”是产品导航分组，不代表 Skill、Tool、Knowledge、Model、Connection 使用同一领域表或同一生命周期。

## 9. 管理后台关键任务

### 9.1 管理 Agent

管理员查看 Agent 自身 Revision、部署、默认装配、允许运行环境、可委派范围和使用范围。普通 Skill/Tool 更新不会制造 Agent Revision；后台在运行详情展示实际 hash。

### 9.2 管理能力变化

平台自动比较 Tool 风险与权限变化。普通文本、描述和参数结构变化正常生效；只读变写入、扩大网络和 Credential、增加不可逆操作时，才创建待审核事项并通知能力负责人或安全管理员。

业务例子：报表 Tool 新增可选的 year 参数可直接生效；新增 delete_report 操作必须审核，不要求所有使用报表 Tool 的 Agent 负责人逐个发布。

### 9.3 排障

管理员从 Thread 进入某个 Turn：

1. 查看用户与 Agent 正式消息。
2. 查看事件时间线和 Child Thread。
3. 展开 Trace，定位模型、Tool、Knowledge、Memory 或 Environment。
4. 查看实际 Revision、Skill hash、Tool Schema hash、权限结果、耗时和错误。
5. 在有权且诊断策略允许时查看脱敏内容。

### 9.4 评测与运营

管理员可以把真实 Turn 脱敏后加入评测集，比较 Agent Revision、模型、Prompt 或高风险能力变化。普通能力更新不自动触发所有 Agent 的批量评测。

## 10. 产品验收

| 问题 | 可验收结果 |
|---|---|
| 员工端到底是什么 | Desktop 和 Web 两个员工入口，共用 Thread 与 Agent |
| 管理端到底是什么 | 类似 AgentKit 的 SnowHarness 后台，管理 Agent、能力、Runtime 和治理 |
| Web 与 Desktop 是否能继续同一任务 | 可以，事件与上下文连续；本地动作仍由 Desktop 执行 |
| Desktop 是否也能处理云端任务 | 能；它具备 Web 的云端能力，并额外连接本地资源和本机环境 |
| 员工是否还要在多个系统间手工搬数据 | 目标是不需要；优先通过受控接口完成，必须页面操作时在 Desktop 右侧继续，敏感提交由员工确认 |
| Thread 是否依赖 Agent 存在 | 否；Agent 目录为空也能创建 Thread 并执行，Thread 不保存主 Agent |
| 运行中输入是否造成重复消息 | 不会，PendingInput 在正式发送前不是 UserMessage |
| 重试是否产生多个相同用户消息 | 不会，旧回答分支被替代，用户消息唯一 |
| 管理员是否要维护每次执行版本表 | 不需要，平台从 Binding、CapabilityUse、ToolCall、ThreadEvent/JobEvent 和 Trace 组合实际记录 |
| capability-market 是否还是独立产品 | 不是，其资产与知识治理并入管理后台 |
