# 决策台账

本文用于维护方案边界，防止早期草案、外部参考和用户最终决定混在一起。优先级固定为：

1. agentkit 会话与后续批注中用户明确确认的决定。
2. 用户确认的 新总方向。
3. 当前项目真实边界。
4. 外部产品和开源项目的参考。
5. 方案推导。

低优先级内容不能覆盖高优先级决定。外部项目做法不能伪装成用户决定。

## 1. 已确认

### 1.1 产品与入口

| 决策 | 业务例子 |
|---|---|
| 同时改造员工 Desktop、员工 Web 和管理后台 | 员工端必须支持 Agent、事件、队列、引导和授权等待，不是只新增后台 |
| 一个 SnowHarness，三端共用 Agent、Thread、身份和策略 | Web 创建的 Thread 可在 Desktop 继续本地任务 |
| Desktop 与 Web 都能处理云端任务，Desktop 是增强入口 | Desktop 具备 Web 的云端能力，并额外使用本地项目、文件、浏览器登录态和本机应用 |
| Desktop 目标形态是任务操作台 | 右侧打开内部系统代员工查询和填表；有受控接口时直接调用，敏感提交由员工确认 |
| 管理后台采用 AgentKit 式治理 | 管理 Agent、部署、Runtime、Skill、Tool、知识、观测、评测、安全、成本 |
| ~~Agent 是唯一可运行资产~~（专题01已修正） | SnowHarness 始终是 Harness 主体，Agent 是可治理、可调用资产，Agent 目录为空合法；仍不新增 Application、ApplicationInstance 或应用市场 |
| capability-market 并入 SnowHarness | 员工和管理员不再面对两个产品与两套 Skill |
| Agent 与 Skill 选择器位于同一任务输入区域 | 员工可选择 Agent 后追加本次 Skill |
| Preview 属于 Harness 面板 | 不再作为 Agent 独立能力 |
| 员工侧部署和 Git 交付不属于本方案 | 但平台仍管理 Agent Runtime 发布与部署 |

### 1.2 Agent

| 决策 | 业务例子 |
|---|---|
| Agent 使用 VeADK 代码或 agent.yaml，不做可视化业务编排 | 多智能体逻辑继续在代码/Harness 表达 |
| VeADK Agent 在本地或公司标准环境开发，再部署到托管 Runtime | 外部 AgentKit 后台用于发布和运行管理，不是云端可视化开发器 |
| 开发、测试、构建、部署复用普通项目体系 | SnowHarness 提供统一入口，不再造一套 IDE/CI |
| 支持托管和标准外部 Runtime | 裸 URL 不能宣称具有完整 Agent Runtime 能力 |
| Agent 可以有默认模型、Skill、Tool 和 Knowledge | 它不是只有角色 Prompt 的空壳 |
| 员工可替换模型、增量追加能力 | 实际 Agent Revision 不支持时 UI 禁用并解释 |
| 平台或任务策略可以强制模型 | 视觉任务不能被换成不支持图片的模型 |
| Agent 默认全员可用，也可按组织主体限制 | 同一范围同时控制展示和服务端使用 |
| 内部测试通过收窄使用范围完成 | 不增加“测试中”生命周期 |
| 删除 Agent CredentialMode | 固定企业连接或个人授权由 Connector 自身定义 |

### 1.3 会话与事件

| 决策 | 业务例子 |
|---|---|
| 员工主轴为 Thread → Turn → Item，Event 独立记录变化 | 员工端不展示 Invocation/Attempt 层级；客户端按 Event sequence 续读 |
| Thread 不保留主 Agent 身份（专题01修正） | Thread 是可治理会话容器；Agent 偏好/交接属后续专题，辅助 Agent 默认用 Child Thread |
| 更换主导 Agent、模型或能力不清空历史 | 变化通过事件记录并在安全决策点生效 |
| Workflow Handoff 必须由员工确认（后续专题） | Thread 已无主 Agent；交接语义由 Agent 调用专题定义，不能静默改变权限继承 |
| Goal 可选 | 长期自治任务使用，普通问答不强制 |
| Item 是当前内容投影，Event 是有序、仅追加变化记录 | Trace 是观测数据，不反向决定业务状态 |
| 每次实际 Agent 执行有内部 Invocation，Attempt 只在整个 Invocation 被基础设施重新调度时物化 | 单个模型请求重试、ToolCall 和 Agent Loop 步骤不创建 Attempt |
| Turn 只保存交互状态和 active/latest/adopted 执行引用 | Revision、模型、Environment、Token 和费用归 Invocation Binding/Trace |
| waiting_user 是可恢复暂停态，不创建新 Turn | UserAction 解析后继续原 Invocation；重调度才建 Attempt |
| Job 与员工 Turn 分开 | 批量、部署、评测和知识构建使用 JobEvent，不伪造用户消息 |
| 高频 Token delta 和心跳默认不永久写 Event | 完成时归并为持久 Item 和 Event，诊断原始流进入 Trace 存储 |
| UserMessage 不因重试复制 | “你好”重试三次仍只有一条用户消息 |
| 运行中普通输入先进入 PendingInput | 未正式发送前可编辑、删除和排序 |
| 引导、中断和停止语义分开 | 引导注入当前 Turn；停止不自动发送下一条 |

### 1.4 Workspace 与 Environment

| 决策 | 业务例子 |
|---|---|
| Workspace 是默认位置，不是强制访问边界 | 用户可以在 snow_harness 任务中读取 skills |
| Workspace 可见、可显式切换，也可附加额外位置 | 切换产生事件，不隐式迁移文件 |
| 用户明确位置优先 | 处理本地 Excel 时输出默认留在原目录 |
| Desktop、Cloud、Remote、Sandbox 是执行环境 | Environment 才负责文件、网络和 Secret 强制边界 |
| OS 权限不等于 Agent 自动权限 | 当前用户能读 SSH 私钥，不代表 Agent 可以读 |
| Desktop 离线不静默切 Cloud | 依赖本地资源的任务等待原设备或用户明确改方案 |
| Agent Runtime、Workspace 与 Sandbox 生命周期分开 | 不可信代码不能在 Agent Runtime 直接执行 |

### 1.5 上下文、Memory 与 Knowledge

| 决策 | 业务例子 |
|---|---|
| Context 在 Agent Loop 内渐进组装 | 先看文件地图，需要时才读全文 |
| 每次模型决策记录来源、hash、Token 和原因 | 不强制复制完整上下文大包 |
| 原始事件不因压缩删除 | 摘要错误时可以回到原消息 |
| Memory 按作用域管理 | Thread、Project、User Preference、Agent、Organization 分开 |
| 通用用户偏好可以跨 Agent | “默认中文”可以跨 Agent |
| 项目和 Agent 业务记忆默认不全局共享 | “订单服务用 PostgreSQL”属于 Project |
| 敏感 Credential 不进入 Memory | Token、验证码和私钥禁止写入 |
| Knowledge Base 与 Memory 分开 | 企业制度不写成个人记忆 |
| 知识图谱属于 Knowledge Base 内部 | Agent 绑定知识库，不单独绑定图谱 |

### 1.6 Skill 与 Tool

| 决策 | 业务例子 |
|---|---|
| Agent Loop 动态发现和装配能力 | 需要合同审查时才加载相关 Skill |
| Skill 默认读取当前生效内容并记录 hash | 普通 Skill 更新不发布所有 Agent |
| 不要求作者维护静态 Skill 依赖树 | 实际加载关系写 CapabilityUse，Event/Trace 不充当配置源 |
| 不用 AI 推断依赖作为发布门禁 | AI 可以选择辅助 Skill，但不改资产关系 |
| Tool 调用前读取当前 Schema | AI 按 Schema 生成参数，缺少时查找或询问 |
| 单次 ToolCall 是稳定边界 | Schema 更新不改变进行中的调用 |
| 普通能力变化自动生效 | 文案和只读可选参数不制造审批负担 |
| 高风险变化集中审核 | 只读变写入、扩大网络、Credential 或不可逆副作用 |
| 只有合规、定时等场景显式固定能力 | 普通聊天不默认锁整个 Turn |
| 产物在执行节点缓存或预装 | 不在每次调用时从能力中心远程下载代码包 |

### 1.7 权限、凭证与安全

| 决策 | 业务例子 |
|---|---|
| AI 选择 Tool 和业务参数，平台决定身份与执行 | AI 不生成 userId 或 Token |
| 安全主结果是 allow / pause / block | 登录和确认都是 pause，但原因不同 |
| 风险按影响、数据去向、环境和可恢复性判断 | 跨目录读取可允许，Workspace 内 rm -rf 仍需确认 |
| 普通代码编辑、测试、构建和本地 Git 正常执行 | 不因传统保守权限频繁打断 |
| 发送、Push、提交、发布、付款等需确认 | 用户看到具体影响 |
| 跨租户、他人数据和平台禁令直接阻止 | 用户确认不能越权 |
| Credential 可被可信执行器使用 | SSH、浏览器 Cookie、Gateway OAuth 正常工作 |
| Credential 原值不进模型、回答、Memory 或观测 | 后台只看指纹、Scope 和诊断 |
| 空 allowlist 和未知目标 fail-closed | 不能把配置缺失当作全允许 |

### 1.8 连续性与协作

| 决策 | 业务例子 |
|---|---|
| 普通交互依靠事件、局部 Checkpoint 和 Tool 记录恢复 | 不为每个模型调用创建 Temporal Activity |
| Tool 副作用使用 operation_id 和结果核对 | 超时先查是否已创建报销单 |
| unknown_effect 不能盲目重试 | 结果不明时暂停人工处理 |
| 发布回滚不等于副作用回滚 | 切回 Agent Revision 不会撤回邮件 |
| 多智能体默认使用 Child Thread | 子 Agent 有独立上下文和事件 |
| 固定顺序/并行/循环可以是 Workflow Agent | 不强制所有协作投影成 ChildRun |
| A2A 外部 Agent 保持独立身份 | 通过标准协议交接，不合并成内部假 Agent |
| Parent/Child 使用结构化 Context Handoff | 不复制完整 Thread 和 Credential |
| Temporal 用于长等待、定时、批量、跨服务和无人值守 | 日报 Job 使用，普通问答不用 |

### 1.9 发布、观测与评测

| 决策 | 业务例子 |
|---|---|
| Agent 自身变化才生成 Revision | Skill 文案更新不生成 Revision |
| 已开始 Invocation 不更换 ExecutionBinding | 新 Turn 或显式 Regenerate 的新 Invocation 采用当前 DeploymentRoute |
| 每个 Invocation 有结构化 Trace | Turn 和 Thread 聚合多个 Trace |
| Trace 与业务 Event 分开 | Trace 丢失不改变 Tool 已成功事实 |
| 默认采集结构、状态、用量和错误 | full_redacted 不再是全平台默认 |
| 内容按 metadata/redacted/diagnostic 策略 | 诊断模式有范围、期限与审计 |
| 观测、评测、审计和安全共享事实但不混表 | 分别回答做了什么、好不好、谁负责、风险如何 |
| 评测复用真实 Runtime 和同构测试环境 | 不用假 Tool 证明“已完成” |
| 普通能力更新不跑全量 Agent 回归 | 高风险变化做针对性评测 |
| 成本、容量和预算进入管理后台 | 按 Agent、用户、模型、Environment 查看 |

### 1.10 领域、数据与 API

| 决策 | 业务例子 |
|---|---|
| 统一领域模型不等于一张万能资源表 | Agent、Tool、Knowledge 各自管理，CatalogEntry 只做搜索投影 |
| 控制配置、会话交互、执行、上下文资源、观测治理分域 | Thread 删除不级联删除 Knowledge 或用户本地文件 |
| 配置资产采用稳定对象 + 不可变修订 | AgentRevision 与 RuntimeRevision 由 DeploymentRoute 组合 |
| Agent interface requirements 与 Runtime capabilities 分开 | Agent required 声明必须能力，RuntimeRevision 探测实际支持能力，Route 发布时校验子集 |
| 会话采用 Thread/Turn/Item 当前状态 + 仅追加 Event | 列表直接查 Item，断线按 Event sequence 续读 |
| Invocation 启动时固定 ExecutionBinding | Route 更新只影响新 Invocation |
| Skill/Tool/Knowledge 实际使用写 CapabilityUse | 动态能力不预先锁成大 Manifest，也能查历史 hash |
| Workspace 逻辑位置与 WorkspaceBinding 实际位置分开 | 本地路径必须同时绑定 Desktop device |
| Actual Execution Record 是只读聚合 | 管理后台组合 Binding、CapabilityUse、Tool/Effect、ThreadEvent/JobEvent 和 Trace |
| 员工、Runtime、管理后台和内部 Gateway 使用四组 API | 外部 Runtime 无权直写 Thread/Item/Event 数据库 |
| Event 使用 Thread sequence 和 Last-Event-ID 续读 | 同毫秒多个事件不会因时间戳游标丢失 |
| 创建和命令接口使用 Idempotency-Key，可编辑资源使用 ETag | Desktop 重发消息不重复创建 Turn，路由并发更新返回 412 |
| Runtime candidate event 先写 Ingress 去重账本再映射 | 重分批或部分重放不重复生成 Item、ThreadEvent 或 JobEvent |

### 1.11 已授权收敛的实施规则

用户明确要求集中补能力发现、多智能体命令、机器协议、Memory/Job 写入边界以及生产运维和安全约束，并推进到可直接实施的规格。下列是该授权范围内形成的架构规则，不伪装成 agentkit 原会话逐项说过的决定；后续若用户修改方向，以新确认覆盖。

| 实施规则 | 业务例子 |
|---|---|
| 员工选择器与 Agent Loop 共用受权限过滤的能力目录 | 搜索结果是候选；加载 Skill 或读取 Tool Schema 后才写 CapabilityUse |
| Child Thread 只能由活跃父 Invocation 通过受控命令创建 | 子 Runtime 不直写父 Thread；结果通过 ThreadRelation 投影 |
| Handoff 统一使用 UserActionRequest（后续专题） | 员工确认后才更新主导 Agent，不建立第二套交接请求事实 |
| Runtime 只能提交 MemoryCandidate | Memory Policy 校验来源、Scope 和敏感性后才写 MemoryEntry |
| 终态 Job retry 创建 replacement Job | 原 Job 的终态、Event 和结果不修改 |
| Event 消费者必须保存 checkpoint 和隔离失败 | 坏事件不会被后续 sequence 越过，修复后从原位置重放 |
| 活跃 Invocation 有唯一 execution ownership | Web/Desktop 同时打开不会静默迁移执行环境 |
| 可执行制品发布前验证 digest、签名、SBOM 和 provenance | 未验证 RuntimeRevision 不能进入 Route |
| 管理授权使用稳定 action_code + resource_scope | 前端菜单权限不能替代服务端判断 |
| 删除经过 RetentionPolicy、Legal Hold 和逐存储步骤 | 命中 Hold 时显示 blocked，不伪装成已清除 |
| API、Event、错误码和 Runtime 一致性用例提供机器契约 | 文档变更未同步 OpenAPI 或 catalog 时 CI 失败 |

## 2. 待确认

这些内容没有被用户最终确认，不能写成已落地设计：

| 主题 | 已确定边界 | 尚未确定 |
|---|---|---|
| MCP | Tool Gateway 兼容动态工具发现和 Schema 变化 | 独立资产、菜单、连接、交付范围和运营方式 |
| 公司 CI/CD | SnowHarness 有统一 Agent 发布入口 | 构建、部署、灰度、回滚和回调的公司接口 |
| 组织与管理员权限 | 服务端按稳定 action_code + resource_scope 判断，外部角色通过 principal_binding 映射 | 对接哪套组织系统及字段、哪些敏感动作启用双人复核 |
| 数据保留 | 已定义 RetentionPolicy、Legal Hold、DeletionRequest/Step、优先级和删除证明 | 各 data_class 的具体天数、当地法规和公司案件系统字段 |
| 公司外部 Runtime 接入细节 | Runtime Protocol 已定义身份、事件、取消、能力探测和 Gateway 边界 | 各 Runtime 的 Adapter、网络和证书配置 |

“待确认”不表示这些都要立即讨论，只表示当前文档不能替用户做决定。

## 3. 已撤回

以下内容曾在会话或旧方案中出现，但已经被后续确认覆盖：

- V10 员工端不动，只新增管理后台。
- Application、ApplicationInstance、SolutionPackage 和应用市场。
- Team 或协作应用等多智能体资产。
- 可视化 Agent 业务编排器。
- Thread 不保留任何主 Agent 身份。
- 切换模型或 Agent 后新建会话、丢失上下文。
- Run、RunAttempt、Step、StepAttempt 作为所有交互的通用产品层级。
- Run Manifest 作为管理员维护的不可变执行中心。
- 每次 Skill/Tool 更新生成 AgentDeploymentRevision，并让绑定 Agent 批量发布和回归。
- 整个 Turn 锁死全部能力版本。
- 删除自动使用当前生效能力。
- pinned/auto 作为所有普通交互必须理解的通用模式。
- ContextEngine、RunContextSeed、StepContextSnapshot 三层强制结构。
- 每次模型调用保存完整上下文大包。
- 所有长期 Memory 默认跨全部 Agent。
- Workspace 首次选择后永久不可切换。
- Workspace 是文件访问沙箱，跨目录必须反复授权。
- OS 用户能访问，所以 Agent 默认也能访问。
- Cloud Workspace 强制接收本地文件任务输出。
- Temporal 包裹每次模型和 Tool 调用。
- 多智能体全部统一为 ChildRun。
- VeADK 整体作为一个不透明 Temporal Activity。
- Trace 默认 full_redacted 全内容采集。
- 将 Credential 原值写入 Trace 后再依赖前端脱敏。
- Agent 使用范围与 Knowledge/Tool 的部门范围机械求交。
- Agent 上保存 CredentialMode。
- 强制作者维护 Skill 静态依赖树，或让 AI 推断依赖作为门禁。
- 能力在运行中每次从互联网远程下载并直接执行。
- 发布回滚等于撤销已发生副作用。
- 评测使用与生产不同的假执行器或内存实现。

## 4. 外部借鉴，不等于用户原始决定

用户已确认采用外部研究后的总方向，因此下列设计可以进入正式架构；其来源仍要保留，不能写成早期会话已经逐项决定：

| 借鉴 | 对 的影响 |
|---|---|
| Codex 的 Thread → Turn → Item 与 resume/fork/steer/interrupt | 形成会话与事件主模型 |
| Claude Code 的 Agent Loop、渐进上下文与 Session/文件状态分离 | Context 按需组装，会话恢复不冒充文件恢复 |
| Kimi/Qoder 的 Session/Event、Goal 可选和独立子会话 | Goal 非强制，多智能体默认 Child Thread |
| AgentKit/VeADK 的本地代码开发、云上发布管理，以及定义/执行分离 | 管理后台治理，Runtime 执行，不把外部平台误写成云端开发器 |
| MCP 动态 tools/list、Schema 和 list_changed | Tool 稳定边界改为单次调用 |
| LangGraph/Temporal 的持久执行 | 降为长任务和后台任务机制 |
| Letta 的分层 Memory | Memory 按作用域与加载方式管理 |
| Langfuse 的 Session/Trace/Observation | Thread 聚合 Trace，Trace 不替代业务事件 |
| OpenHands 的 UI、Agent Server 和执行后端分离 | Desktop/Web 共平台，可接不同 Environment |
| OpenCode 的持久 SessionEvent 与消息投影并存 | Event 账本与 Item 查询模型并用；高频 delta 保持临时 |
| Qwen Code 的 Skills、Subagents、Teams、MCP 和 daemon 多客户端会话 | 能力发现、独立子任务和多客户端不等于把执行状态塞进一个前端进程 |
| MCP 2025-11-25 tools/list、JSON Schema 和 listChanged | 形成能力 search、单次 Tool Schema 固定和目录 revision 失效边界 |

外部产品的字段、表和 UI 不直接照搬；只借鉴被确认的结构原则。

## 5. 与旧文档的关系

本目录是 当前方案基线。docs/03-智能体 中与本台账冲突的内容均视为早期历史，不作为兼容路径。

旧方案中以 Run/Attempt/Temporal/完整快照为主轴的文件已被当前文档替代。后续实施必须以 [统一领域模型](./domain-model.md)、[核心数据模型](./persistence.md)、[基础 API 与 Event 边界](./api-and-events.md)、[能力与协作 API](./capability-and-collaboration-api.md)、[Memory 与 Job API](./memory-and-job-api.md)、[生产运维与数据生命周期](./security.md) 和 [机器契约](./contracts-and-conformance.md) 为准。
