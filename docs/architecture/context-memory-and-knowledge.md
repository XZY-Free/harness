# 上下文、Memory 与 Knowledge

## 1. 定位

上下文封装是 Agent Loop 的核心能力，但不再设计成管理员可见的 ContextEngine 产品，也不要求每次模型调用保存一份完整 StepContextSnapshot。

采用 Context Assembly（上下文组装）：

~~~mermaid
flowchart LR
  Index["会话索引 / 文件地图 / 能力描述"] --> Decide["Agent Loop 判断缺口"]
  Decide --> Load["按需加载"]
  Sources["Thread / Memory / Knowledge / Workspace / Tool Result"] --> Load
  Policy["权限 / 信任 / Token / 数据策略"] --> Load
  Load --> View["本次 Model Context View"]
  View --> Model["模型决策"]
  Model --> Result["消息 / ToolCall / 子 Agent / 完成"]
  Result --> Decide
~~~

平台负责事实、索引、权限、来源、压缩和审计；Runtime 在每次模型决策前组装当时需要的视图。模型不能绕过平台读取未挂载 Memory、Knowledge 或文件。

## 2. 上下文事实与视图分开

### 2.1 事实

长期保存且可以独立追溯：

- Thread、Turn 与 Item 内容，以及 Event 提供的变化引用。
- 用户正式消息和 Agent 正式回答。
- ToolCall、ToolResult 与副作用状态。
- 文件、Artifact、Knowledge 文档和 Memory 条目。
- Agent Revision、Skill 内容和 Tool Schema 的 hash。
- 用户确认、权限结果和执行环境。

### 2.2 视图

模型本次看到的有限内容：

- 平台规则和 Agent 指令。
- 当前消息、已确认约束与工作状态。
- 最近对话或压缩摘要。
- 本次相关的 Skill、Memory、Knowledge 和文件片段。
- Tool 定义与最近结果。

视图可以重新生成，事实不能被摘要替代。Trace 记录视图的来源、hash、Token、选择原因和必要内容引用；完整正文按采集策略保存。

业务例子：早期对话被压缩后，用户“只改测试代码”的约束仍来自原 user_message Item，并可通过对应 item.created Event 追溯变化。摘要写错时，平台可以回看原 Item 并重新压缩，而不是把错误摘要当成唯一事实。

## 3. 渐进加载

### 3.1 首次提供

模型首先获得：

1. 平台安全与运行规则。
2. 当前 Agent 指令。
3. 当前用户消息。
4. 已确认约束、决定、目标和未完成事项。
5. 最近必要对话。
6. 可用资料和能力的简短索引。

### 3.2 按需展开

只有 Agent 判断需要时才加载：

- 某个 Skill 的完整指令。
- 具体 Tool 的当前 Schema。
- Workspace 文件片段。
- Knowledge 文档与图谱证据。
- 某一作用域的 Memory。
- 超大 ToolResult 的详细内容。
- Child Thread 的结构化结果。

### 3.3 更新工作状态

每次行动后更新：

- 已完成和未完成事项。
- 新的 Tool 结果和副作用。
- 文件与 Artifact 变化。
- 用户新的引导或确认。
- 错误、阻塞和恢复点。

下一次模型决策基于最新状态组装，而不是从 Turn 开始时的一份静态大包继续。

业务例子：Agent 先看到仓库文件地图，判断错误可能在 auth 模块后才读取相关文件；运行测试后只把失败用例和相关日志装入下一次上下文，而不是重新发送整个仓库。

## 4. Context Fragment

所有候选内容都转换为带来源和策略的 Fragment：

| 字段 | 作用 |
|---|---|
| kind | system、agent_instruction、user、memory、knowledge、file、tool 等 |
| source_ref | 原始事件、文档、文件、Memory 或 ToolResult |
| scope | Thread、Project、User、Agent、Organization |
| trust | 指令、可信数据、不可信外部数据 |
| sensitivity | 数据分类与外发限制 |
| content_hash | 实际内容摘要 |
| token_estimate | 上下文预算 |
| freshness | 更新时间、有效期和是否需要刷新 |
| reason | 为什么选入或排除 |

外部网页、文件、Knowledge 和 ToolResult 默认是数据，不因正文包含“忽略上面的指令”而获得指令优先级。

## 5. 优先级与预算

平台先为模型输出和 Tool 结果预留空间，再按以下顺序选择：

1. 平台强制规则和当前 Agent 指令。
2. 当前用户要求与运行中引导。
3. 已确认约束、决定、Goal 和未完成事项。
4. 最近原始对话与直接相关结果。
5. 任务相关的 Workspace、Knowledge、Memory 和 Skill。
6. Tool 结果摘要与 Child Thread 结果。
7. 更早历史的压缩摘要。

不写死统一百分比。不同模型和任务窗口不同，但安全规则、当前用户要求和已确认约束不能被低优先级资料挤掉。

当预算不足时：

- 先删重复日志、无关进度和可重新查询内容。
- 保留 ToolCall 与 ToolResult 配对。
- 把长结果转为结构化摘要和引用。
- 记录被排除内容及原因。
- 如果关键内容仍无法容纳，明确失败或换用允许的长上下文模型，不能静默丢掉约束。

## 6. 压缩

压缩只生成模型视图的 Checkpoint，不删除原始事件。

~~~yaml
goal:
constraints:
confirmed_decisions:
current_state:
completed:
pending:
artifacts:
side_effects:
important_failures:
user_preferences:
source_event_refs:
~~~

压缩流程：

1. 确定性移除重复日志和无意义进度。
2. 保证 ToolCall、审批、ToolResult 和副作用状态成组。
3. 提取目标、约束、决定、文件、错误和任务状态。
4. 生成结构化摘要。
5. 校验引用存在、金额和关键标识没有漂移。
6. 保留最近原始事件。
7. 记录压缩版本、来源范围和评测结果。

连续压缩需要监控决定保留率、约束保留率和事实漂移。摘要可以重新生成，不能覆盖原始消息。

业务例子：一个月的项目 Thread 压缩后保留“不要升级 PostgreSQL”“测试环境地址已变更”“还剩三个失败用例”，而普通测试通过日志只保留计数和引用。

## 7. Trace 记录什么

默认结构化记录：

- 每次模型决策使用的 Fragment 来源与 hash。
- Token 数、优先级和选择原因。
- 使用的压缩 Checkpoint。
- 实际 Agent Revision、模型、Skill 与 Tool Schema hash。
- 排除的关键候选及原因。
- 模型调用状态、耗时和费用。

完整 Context View 正文按策略采集：

| 策略 | 行为 |
|---|---|
| metadata | 不复制正文，只保留引用、hash、Token 和结构 |
| redacted | 保存脱敏后的必要输入输出 |
| diagnostic | 指定范围、有效期和查看权限内保存更完整内容 |

Credential 原值永远不进入 Context 或 Trace。对生产敏感资料，管理员“为了排障”也不能绕过租户的数据策略。

## 8. Memory 作用域

用户早期确认过“长期记忆属于用户，跨 Thread、跨 Agent”。后续整体重审进一步明确：真正适合跨 Agent 的是通用用户偏好；项目事实、Agent 业务习惯和敏感内容不能默认全局共享。因此 不再用一个全局用户桶装所有长期记忆。

### 8.1 Thread Memory

保存当前会话中的：

- 临时决定与约束。
- 当前计划和未完成事项。
- 已执行副作用和等待状态。
- 会话中的实体指代。

默认只在当前 Thread 使用。

### 8.2 Project / Workspace Memory

保存：

- 技术栈、目录结构和工程约定。
- 项目运行方式、测试规则和已确认架构决定。
- 项目任务状态与常用资料引用。

只有挂载同一项目的 Agent 可检索。它不应因为“用户说过一次”就变成个人全局偏好。

### 8.3 User Preference Memory

保存稳定、低风险、跨任务有价值的个人偏好：

- 默认使用中文。
- 报表默认人民币。
- 代码解释希望先给结论。

这一类可以跨 Thread、跨 Agent，但每次仍按相关性检索。

### 8.4 Agent-specific Memory

保存某个 Agent 与该用户长期协作的业务信息：

- 财务助手的报表格式偏好。
- 招聘助手中经用户确认的岗位筛选习惯。

默认不提供给无关 Agent。

### 8.5 Organization Memory

保存组织共享的策略、术语和公共事实，但强约束内容更适合 Knowledge 或平台配置。安全策略和系统指令不属于可学习 Memory，不能被自动提取覆盖。

## 9. Memory 挂载与检索

每个 Agent/Thread 只挂载当前任务允许的 Memory Store：

~~~text
Thread 默认挂载
├─ 当前 Thread
├─ 当前 Workspace / Project
├─ User Preference
├─ 当前 Agent-specific
└─ 允许的 Organization Store
~~~

Agent Loop 先看到 Store 描述和索引，再按任务检索少量条目。跨范围读取必须有明确挂载和权限，不允许模型猜测另一个 Store ID。

业务例子：代码 Agent 可以读“默认中文”与当前项目“使用 PostgreSQL”，但不应读招聘助手保存的候选人筛选习惯。

## 10. Memory 写入

写入分三种：

### 10.1 用户明确要求

用户说“记住以后报表都用人民币”时，平台展示将写入的内容和作用域。默认建议 User Preference；用户可以改为当前 Thread 或当前 Agent。

### 10.2 系统提出候选

Agent 可以提交 Memory Candidate，平台完成：

- 作用域分类。
- 去重和冲突检测。
- 敏感信息检查。
- 来源记录。
- 过期策略。

候选不能静默写入宽于来源的作用域。项目事实默认进入 Project，不升级到 User Preference。

### 10.3 管理员维护

组织 Memory 或 Knowledge 由授权管理员维护，并记录变更和来源。管理员规则不能伪装成模型自动学到的事实。

## 11. Memory 禁止内容与用户控制

禁止写入：

- 密码、Token、验证码和私钥。
- Session Cookie 和完整 Credential。
- 未经允许的身份证、银行卡、健康等敏感个人信息。
- 临时一次性业务数据。
- 模型猜测但用户或外部事实未确认的内容。

用户可以查看、修改、删除和关闭自动候选。自动提取不能覆盖用户明确设置。删除正文时同步清理索引和缓存；来源 Thread 删除是否连带删除 Memory，按该条目的作用域、用户选择和企业保留策略处理。

## 12. Knowledge Base

Knowledge Base 保存组织或业务资料，和 Memory 分开：

~~~text
Knowledge Base
├─ Source
├─ Document / Chunk
├─ Full-text Index
├─ Vector Index
└─ Knowledge Graph
   ├─ Entity
   ├─ Relation
   └─ Evidence
~~~

Agent 绑定 Knowledge Base，不单独绑定 Knowledge Graph。检索服务根据问题使用全文、向量、图谱或混合召回，并把证据来源返回 Agent Loop。

业务例子：财务制度库同时包含 PDF 制度、向量索引和“城市—住宿上限—生效日期”的图谱关系。Agent 只选择财务制度库，检索服务决定哪种方式更合适。

## 13. Knowledge 加载

### 13.1 先目录后证据

Agent 先看到可用 Knowledge Base 的名称、描述、更新时间和权限；需要时提交查询。平台返回：

- 相关片段。
- 文档与修订。
- 图谱实体、关系和证据。
- 相关性、时效和权限结果。

### 13.2 数据保持最新

Knowledge 内容不跟随 Agent Revision 冻结。每次检索使用当时允许的最新内容；CapabilityUse 记录实际文档修订/hash，证据引用进入检索结果，Event 只记录员工可见变化，Trace 补充选择原因和诊断。

离线评测需要可比时，可以固定测试 Knowledge 快照；普通交互默认读取当前事实。

### 13.3 检索失败

权限拒绝、索引不可用和“确实无结果”必须区分。不能把服务故障伪装成空结果让模型回答“制度没有规定”。

## 14. 与 Skill 和 Tool 的边界

| 对象 | 解决什么问题 | 典型内容 |
|---|---|---|
| Skill | 怎么做 | 分析步骤、写作规范、审查方法 |
| Tool | 执行什么动作 | 查 ERP、写文件、发消息 |
| Memory | 当前主体过去确认了什么 | 偏好、项目约定、协作习惯 |
| Knowledge | 组织或业务事实是什么 | 制度、手册、实体关系和证据 |

同一文本不能为了方便同时复制到四处。平台通过引用和检索组合，而不是制造四份事实源。

## 15. 失败与恢复

| 失败 | 处理 |
|---|---|
| Memory 检索失败 | 明确标记 unavailable，不伪装为空 |
| Knowledge 检索失败 | 返回错误类型和可重试性 |
| Context Checkpoint 失败 | 对即将产生副作用的行动暂停，避免无法恢复 |
| 观测上传失败 | 本地或平台持久队列补传，不阻断低风险读取 |
| 权限在运行中撤销 | 下一次加载或 ToolCall 重新判断，不能沿用旧授权 |
| Desktop 文件变化 | 重新读取 hash 并提示上下文已变化 |

## 16. 评测指标

- 约束与决定保留率。
- 压缩摘要忠实度。
- 无关 Token 比例。
- Knowledge 证据命中率与时效性。
- Memory 相关命中、误召回和跨作用域泄露率。
- Agent 切换与 Child Thread 的上下文隔离。
- ToolCall / ToolResult 配对完整率。
- 连续压缩后的任务完成率。

## 17. 验收检查

| 检查 | 通过条件 |
|---|---|
| 是否每次发送全部历史 | 否，先索引后按需加载 |
| 是否强制保存完整上下文副本 | 否，默认保存结构、来源和 hash |
| 长期记忆是否全局共享 | 只有 User Preference 可默认跨 Agent，其他按最窄作用域 |
| 安全策略是否写进 Memory | 否，属于确定性平台配置 |
| 知识图谱是否独立绑定 | 否，属于 Knowledge Base 内部 |
| Knowledge 是否跟 Agent Revision 冻结 | 否，普通运行读取当前内容并记录修订 |
| 检索服务故障是否返回空 | 否，必须区分无结果与不可用 |
