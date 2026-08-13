# Skill、Tool、MCP 与安全

## 1. 总体边界

把“AI 应该理解什么”和“平台必须强制什么”分开：

| AI / Agent Loop | SnowHarness Platform |
|---|---|
| 理解 Skill 文本 | 管理来源、可见范围、当前内容和 hash |
| 选择 Tool | 只暴露允许的 Tool |
| 根据 Schema 生成业务参数 | 注入身份、连接、Credential 和 Trace |
| 缺少参数时查询或询问用户 | 校验参数、权限、环境和副作用 |
| 根据 ToolResult 决定下一步 | 执行、审计、幂等、风险与结果核对 |

Skill 和 Tool 不是传统静态包依赖系统。平台不要求每个 Agent 管理员为普通能力更新创建 Revision，也不要求作者维护不可靠的 Skill 依赖树。

## 2. 统一目录，不统一错误生命周期

管理后台可以用一个“能力与知识”入口完成搜索、所有者、可见范围、标签和状态治理，但对象仍保留不同语义：

| 对象 | 内容 | 更新与运行特点 |
|---|---|---|
| Skill | 文本指令、示例和辅助资源 | 按需加载当前生效内容 |
| Tool | Schema、执行器和操作定义 | 每次调用前动态发现 |
| MCP | 标准 Tool/Resource/Prompt 提供协议 | 是否建设独立产品能力待确认 |
| Knowledge | 文档、索引和图谱证据 | 按查询读取当前事实 |
| Memory | 按主体和用途保存的经验信息 | 按作用域挂载和检索 |

不能因为它们同在一个页面，就强行使用同一 Version、Artifact、审批和权限模型。

## 3. Skill

### 3.1 定义

Skill 是 Agent 可发现、可按需读取的指令与资源包，适合表达：

- 分析和写作方法。
- 业务操作步骤。
- 领域检查清单。
- 可复用提示与示例。
- 少量与方法配套的资源。

Skill 不等同于 Tool。Skill 说明“怎么做”，Tool 提供“可以执行的动作”。

### 3.2 管理信息

平台至少管理：

- 稳定标识、名称、描述和所有者。
- 可见范围与状态。
- 来源、许可证和完整性。
- 当前生效内容、历史内容和内容 hash。
- 适用场景与安全分类。
- 实际使用事件和影响分析。

历史内容不可原地覆盖，便于追溯；普通运行默认读取当前生效内容，不要求用户选择 semver。

### 3.3 渐进加载

~~~text
Agent 先看到 Skill 名称和描述
→ 判断当前任务需要
→ 读取当前生效内容
→ 记录 Skill 标识和内容 hash
→ 在本次模型决策中使用
~~~

同一次模型决策已加载的内容不会被中途替换。下一次决策若 Skill 已更新，可以使用新内容；`CapabilityUse` 记录实际版本和 hash，员工可见变化才追加 Event，Trace 只补充选择原因和耗时。

业务例子：“公司写作规范”在 Agent 起草报告时才加载全文；用户只查询订单状态时不占用上下文。

### 3.4 Skill 调用 Skill

不要求作者预先声明整棵依赖树，也不让 AI 推断依赖作为发布门禁。一个 Skill 或 Agent 需要另一个 Skill 时，可以在运行中发现并加载。

平台只做运行保护：

- 最大加载数量和嵌套深度。
- 当前调用路径循环检测。
- Token、时长和费用预算。
- 不可用或无权限时明确失败。
- 实际父子使用关系写入 CapabilityUse；Event 只记录员工可见边界，Trace 补充诊断细节。

业务例子：合同审查在某一案件中加载法律顾问和条款对比 Skill；另一个简单合同只加载条款对比。平台记录真实关系，不要求作者维护一张可能过期的理论图。

## 4. Tool

### 4.1 Tool Contract

Tool 必须提供：

- 稳定标识与当前描述。
- 机器可读输入 Schema。
- 输出结构或内容类型。
- 操作类型与潜在副作用。
- 可用执行器和 Environment。
- 认证与连接要求。
- 超时、取消和幂等能力。
- 数据目的地与网络范围。

Schema 不是写死在 Agent 框架里的参数对象。Agent Loop 在调用前读取当前 Schema，AI 根据要求生成业务参数；缺少信息时继续查找、调用辅助能力或询问用户。

### 4.2 调用流程

~~~mermaid
sequenceDiagram
  participant L as Agent Loop
  participant G as Tool Gateway
  participant P as Policy
  participant E as Executor

  L->>G: 查询当前 Tool 描述与 Schema
  G-->>L: Schema + capability metadata
  L->>G: ToolCall 业务参数
  G->>P: 身份、权限、风险、环境、Credential
  P-->>G: allow / pause / block
  G->>E: 注入系统参数并执行
  E-->>G: 结果、effect status、诊断
  G-->>L: ToolResult
~~~

模型生成：

- 查询词、日期、业务单号。
- 用户在自然语言中明确的目标和选项。

系统注入：

- tenantId、userId、Thread/Turn 标识。
- 连接状态、Credential 引用和授权结果；原值与短期令牌不进入模型工作状态。
- Trace、幂等标识和安全标签。
- 实际执行环境。

模型不能伪造系统参数。

### 4.3 稳定边界是单次 ToolCall

- 调用前解析当前描述和 Schema。
- ToolCall 开始后固定该调用使用的 Schema hash、权限结果和执行器。
- Schema 在调用中更新，不改变正在执行的调用。
- 下一次模型决策前刷新工具列表和 Schema。
- ToolCall 与 CapabilityUse 保留当时实际 Schema revision/hash；Event 只记录调用状态变化。

不需要为整个 Turn 锁死所有可能用到的 Tool 版本，也不需要为 Tool 更新批量生成 Agent Revision。

业务例子：发票查询 Tool 新增可选 invoice_type。当前正在执行的调用按旧 Schema 完成；下一次调用读取新 Schema，AI 可以填写新字段。

## 5. 能力变化与审核

平台自动比较新旧能力的结构和风险，不把所有更新交给每个 Agent 管理员。

### 5.1 可直接生效

- Skill 文案、示例和说明修正。
- Tool 描述改进。
- 新增只读可选参数。
- 输出增加不影响已有字段的诊断信息。
- 修复实现但不扩大权限、网络和副作用。

### 5.2 必须集中审核

- 只读操作变为写入。
- 新增删除、发送、发布、付款或提交。
- 扩大网络出口或数据目的地。
- 新增 Credential、权限 Scope 或用户委托身份。
- 从测试环境扩大到生产环境。
- 扩大文件、数据库、对象存储或业务系统范围。
- 取消幂等或无法核对副作用。

审核对象是能力变化本身，由能力负责人和安全管理员处理。平台根据实际使用事件列出可能受影响的 Agent 和任务，但不要求所有 Agent 负责人逐个重新发布。

### 5.3 针对性评测

高风险变化或明确策略可以触发相关用例评测。普通文字和兼容 Schema 更新不触发全平台所有 Agent 的回归。

业务例子：ERP Tool 新增 order_note 只读字段可自动生效；新增 cancel_order 操作需要安全审核、测试环境验证和订单 Agent 的取消场景评测。

## 6. 固定能力的适用场景

普通交互默认使用当前生效能力并记录事实。以下场景可以显式固定 Agent Revision、Skill 内容或 Tool Contract：

- 合规审计要求严格复现。
- 定时、批量和无人值守任务。
- 法务、财务等经过认证的固定业务流程。
- 离线基准评测。
- 事故回放。

固定是任务或部署策略，不是所有 Agent 的默认负担。

业务例子：季度财务关账任务固定 Agent Revision、财务 Skill hash 和 ERP Tool Contract；普通员工查询报销状态使用当前生效能力。

## 7. Artifact 与本地加载

Skill 资源和 Tool 执行产物不能在每次调用时依赖能力中心远程传输。

~~~text
能力中心登记来源与 hash
→ Artifact Resolver 检查执行节点内容寻址缓存
→ 命中则直接使用
→ 未命中则下载、校验并缓存一次
→ Runtime 或 Sandbox 本地加载
~~~

文本 Skill 可通过平台服务读取，但 Runtime 应缓存并以 hash 校验；代码、资源包和二进制 Tool 必须物化到实际执行节点。

外部互联网资源不能被 Agent 临时当作已批准能力直接执行。它需要先进入允许的来源与安全流程。

### 7.1 其他项目如何使用能力

其他项目通过 API、SDK 或 CLI：

1. 查询能力元数据、当前 hash 和可用 Artifact。
2. 本地 hash 未变化时继续使用缓存。
3. 内容变化时下载并校验一次。
4. 在项目或执行节点本地加载。

平台不提供“每个模型决策都远程读取 Skill/Tool 文件后直接执行”的模式。无论通过内容接口读入内存还是通过 Artifact 接口落盘，只要执行节点没有内容都需要传输；按 hash 下载一次并本地复用，能避免每次执行依赖能力中心的网络与可用性。

业务例子：三个项目都使用同一个报表 Skill hash，运行节点只缓存一份内容；Skill 更新后，项目下一次同步发现 hash 改变才重新下载。

## 8. MCP

### 8.1 当前决定

agentkit 会话明确要求 MCP 先不建设、待后续单独讨论。因此本方案不确认：

- 独立 MCP 资产和菜单。
- MCP Server 注册、发布和运营流程。
- 具体连接表、Gateway 路由和用户授权页面。
- 哪些 MCP 进入 交付范围。

### 8.2 必须保留的兼容边界

即使暂不建设独立 MCP 产品，Tool 架构仍应兼容标准的动态工具提供方：

- 能列出当前工具与 JSON Schema。
- 能通知工具列表变化。
- 下一次模型决策前刷新。
- 已经开始的 ToolCall 保持稳定。
- ToolCall 仍经过平台权限、Credential、风险和审计。

这些是 Tool Gateway 的通用能力，不等于 MCP 已经立项。

### 8.3 未来接入原则

未来若确认 MCP：

- MCP Server 不是因为“已连接”就自动获得全部数据。
- Server 提供的风险声明只是输入，平台独立判断实际影响。
- Credential 留在连接层，不进入模型。
- 工具列表变化按本章能力变化规则判断是否需要审核。
- 远程 MCP 的网络、租户和数据目的地进入 Execution Environment 策略。

## 9. 三类执行能力

| 类型 | 例子 | 执行位置 |
|---|---|---|
| Agent 内部纯函数 | 税额计算、格式转换 | 受隔离 Agent Runtime，产生 Trace |
| 平台 Tool | Knowledge、ERP、Browser、Workspace | Tool Gateway 路由到受控执行器 |
| 临时生成代码 | Python、Shell、JavaScript 分析脚本 | Sandbox |

Agent 项目中的 Python Tool 不能因为“内部函数”就绕过平台访问数据库、网络或 Secret。纯计算可以在 Runtime 内执行；需要平台资源或副作用的调用必须经过 Gateway。

## 10. 权限结果

平台只使用三种主结果：

~~~text
allow
├─ observe
└─ redact

pause
├─ confirm_operation
├─ authenticate_connection
├─ grant_permission
└─ provide_input

block
└─ 用户确认也不能绕过
~~~

确认、登录、授权和补充信息在产品上都是等待用户，但恢复动作不同，后台必须保留原因。

业务例子：

- 删除数据库表：pause / confirm_operation。
- 财务系统未登录：pause / authenticate_connection。
- 缺少系统权限：pause / grant_permission。
- 缺少报表年份：pause / provide_input。
- 跨租户访问：block。

## 11. 风险判断

风险由以下因素共同决定：

- Tool 操作和实际参数。
- 数据分类与目的地。
- Environment 与租户。
- 可恢复性和影响范围。
- 用户本次明确意图。
- 是否产生外部、正式或付费结果。
- 当前安全策略与紧急禁令。

Workspace 内外不是风险判断依据，Tool 名称也不能直接代表风险。

| 操作 | 默认处理 |
|---|---|
| 普通读取、查询、分析 | allow |
| 正常代码、配置和文档修改 | allow 并记录 |
| 测试、构建、本地 Git | allow 并记录 |
| 删除可重建缓存或明确可恢复文件 | 按任务意图 allow |
| 批量删除、覆盖重要文件 | pause |
| 发送、Push、提交、发布、付款 | pause |
| 生产不可恢复删除、跨租户、读取他人数据 | block |

相同 execute_sql Tool 对 SELECT、测试库小范围 UPDATE、批量 DELETE 和生产 DROP TABLE 必须得到不同结果。

## 12. 用户确认的范围

确认绑定：

~~~text
tool
operation
target
arguments_hash
effect_summary
expires_at
~~~

确认删除一个文件不能被 Agent 换成删除整个目录。连续同类操作可以授予当前 Turn 或 Goal 内的窄范围权限，但必须限定 Tool、操作和目标。

已经开始执行的副作用 ToolCall 使用稳定 operation_id。超时后先核对目标系统，不能因用户点击“重试”就重复发送或付款。

## 13. Credential

CredentialMode 从 Agent 模型删除。连接自身定义：

- 固定企业连接。
- 当前用户个人授权。
- 无认证。

Turn 或 Job Invocation 携带当前 Actor Context，连接层根据用户和 Tool 获取正确 Credential。

### 13.1 允许使用

- SSH 进程使用本机私钥。
- 浏览器使用已有 Cookie。
- Gateway 注入 OAuth Token。
- Desktop 在用户明确任务中使用本地项目配置启动应用。

### 13.2 禁止暴露

- Credential 原值进入模型 Context。
- 写入 Agent 回答、Memory 或 Knowledge。
- 写入 Event、Trace、Log 或 Payload。
- 传给无关 Tool、MCP 或外部模型。
- 由模型选择账号或构造 userId。

### 13.3 诊断

后台只保存：

- Credential ID、类型和来源。
- 脱敏值与指纹。
- Scope、签发方、过期时间和刷新结果。
- SSH 算法、位数和文件权限。
- Cookie 名称、Domain、Path 和有效期。
- 注入目标、认证结果、状态码和错误。

确需检查原值时，必须从原始 Credential Source 经专门入口、强身份验证和审计读取，不能从 Trace 还原。

## 14. 安全围栏

检查点：

~~~text
用户输入
→ Context Assembly
→ 模型请求
→ 模型响应
→ ToolCall 前
→ ToolResult 后
→ 文件 / Bash / Sandbox
→ 最终回答与外发
~~~

覆盖：

- 直接与间接提示词注入。
- 敏感数据不当外发。
- 越权、跨租户和未注册目标。
- 破坏性操作和不可逆副作用。
- 恶意消耗、无限循环和异常输出。
- Tool 参数、连接目标与 Environment 风险。

安全与质量分开。幻觉、回答不准确、召回差和风格问题进入评测，不应被安全围栏当成攻击阻断。

## 15. 策略层级

~~~text
平台强制规则
> 组织安全策略
> Agent 更严格配置
> 当前操作的窄范围授权
~~~

- 平台强制规则不可关闭。
- Agent 只能收紧。
- 普通策略变化在下一安全检查点生效并记录版本。
- 紧急封禁可以阻止正在运行的危险 ToolCall。
- 空 allowlist、未知目标和安全边界不明时 fail-closed。

## 16. 安全服务故障

- 普通对话和低风险本地读取：本地确定性规则通过后可以继续，记录告警。
- 发送、删除、付款、发布和敏感数据外发：安全服务不可用时 pause 或 block。
- 未注册、未知目标与空允许列表：block。
- 故障进入事件、Trace 与安全事件，不能静默放行。

## 17. 验收检查

| 检查 | 通过条件 |
|---|---|
| Skill 更新是否批量生成 Agent Revision | 否 |
| Tool Schema 是否写死在 Agent | 否，调用前读取当前 Schema |
| 整个 Turn 是否锁死所有 Tool 版本 | 否，稳定边界是单次 ToolCall |
| 普通能力变化是否要求所有 Agent 回归 | 否，只有高风险变化或明确策略针对性评测 |
| 作者是否必须维护 Skill 依赖树 | 否，运行时发现并记录实际关系 |
| MCP 是否被伪装成已建设 | 否，只定义兼容边界，独立产品仍待确认 |
| AI 是否决定 Credential | 否，连接层和 Actor Context 决定 |
| Credential 原值是否进入观测 | 否 |
| OS 能读是否等于 Agent 能读 | 否，仍需平台、用户意图和 Environment 共同允许 |
