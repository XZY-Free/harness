# 核心数据模型

## 1. 存储结论

不采用纯事件溯源，也不继续让 `Message`、`ThreadRun`、`RunTranscriptChunk` 各自形成事实源。目标存储采用混合模型：

| 数据类型 | 写入方式 | 主要用途 |
|---|---|---|
| Agent、Runtime、Skill、Tool、Policy | 稳定对象 + 不可变修订 | 发布、回滚、权限和目录 |
| Thread、Turn、Item | 关系表当前状态 | 员工查询、模型上下文和业务约束 |
| ThreadEvent / JobEvent | 各自仅追加、有序 | 会话续读、后台恢复、投影和变化审计 |
| Invocation、ToolCall、Effect | 关系表执行事实 | 重试、幂等和实际执行记录 |
| Workspace、Memory、Knowledge、Artifact | 独立资源表 | 上下文和内容来源 |
| Trace、Evaluation、Audit | 独立观测存储或索引表 | 排障、评测、治理和成本 |

MySQL 保存控制数据、交互事实和执行索引；大 Artifact、原始日志、诊断内容和评测附件进入对象存储；全文、向量与 Trace 可以使用专用存储，但必须以这里定义的 id 关联。

业务例子：Agent 的最终回答保存在 `thread_item`，回答完成写入 `thread_event`；回答生成过程的模型耗时保存在 Trace，生成的 Excel 保存在对象存储并由 `artifact` 引用。三者不会复制同一份大内容。

## 2. 命名与公共字段

目标表使用 `snake_case`。下文是逻辑模型，落地 MySQL 时保持以下规则：

| 规则 | 定义 |
|---|---|
| 主键 | `CHAR(36)` UUID；新数据优先 UUIDv7，兼容现有 UUID |
| 时间 | `DATETIME(3)`，应用与数据库统一 UTC |
| 状态列 | 使用有业务含义的名字，如 `execution_state`、`lifecycle_state`；不用裸 `status` |
| JSON | 只存类型化负载、稀疏扩展或脱敏摘要；可检索主字段必须独立成列 |
| 内容 hash | `VARCHAR(128)`，值包含算法前缀，如 `sha256:...` |
| 并发 | 可编辑聚合包含 `version_no`，管理 API 通过 ETag/If-Match 更新 |
| 软删除 | 需要恢复或被历史引用的对象使用 `deleted_at`；事件和修订不可物理覆盖 |
| 租户 | 业务根对象包含 `tenant_id`；跨表访问必须同时校验租户，不只凭 id |
| Secret | 业务表只保存 `credential_ref_id`、指纹和 Scope；密文进入 Secret Vault |

不为所有表机械加入 tenant_id。`turn`、`thread_item`、`thread_event` 等通过不可变 `thread_id` 继承租户；查询和分区热点表可冗余 `tenant_id`，但写入时必须校验一致性。

### 2.1 身份引用

不复制一套公司组织主数据，只保存平台需要的稳定映射；部门、用户组和岗位来自组织系统并由同步/鉴权 Adapter 转成主体引用。

| 表 | 核心字段 | 关键约束 |
|---|---|---|
| tenant | id、external_tenant_ref、display_name、lifecycle_state、created_at、updated_at | `UNIQUE(external_tenant_ref)` |
| user_identity | id、tenant_id、external_subject、email、display_name、identity_state、last_login_at、created_at | `UNIQUE(tenant_id, external_subject)`；email 不是身份主键 |
| device | id、tenant_id、user_id、device_key、public_key、device_name、app_version、device_state、last_active_at、revoked_at、created_at | `UNIQUE(tenant_id, device_key)`；私钥只在 Desktop Keychain |
| principal_binding | id、tenant_id、principal_type、principal_ref、external_group_ref、valid_from、valid_until | 用于 user、group、role、department 的访问范围映射；具体组织字段仍由对接系统决定 |

业务表中的 `owner_user_id`、`created_by` 和 `device_id` 引用这里的稳定 id。身份 Token 中的外部 subject 必须先映射，不能直接把邮箱或模型提供的 userId 当外键。

### 2.2 `idempotency_record`

所有创建和命令 POST 共用平台幂等账本，不能只依赖 ThreadEvent：

| 字段 | 说明 |
|---|---|
| id / tenant_id | 主键和租户 |
| audience | employee、runtime、gateway、admin |
| caller_type / caller_id | 用户、设备、Workload 或 Service Identity |
| command_scope | 规范化接口名和资源 Scope，如 `turn.create:thr_x` |
| idempotency_key / request_hash | 调用方 key 和规范化请求 hash |
| processing_state | processing、completed、failed |
| http_status / response_ref / response_redacted_json | 原状态码、资源引用和可安全重放的小响应 |
| created_at / completed_at / expires_at | 生命周期 |

约束：`UNIQUE(tenant_id, audience, caller_type, caller_id, command_scope, idempotency_key)`。同 key 不同 request_hash 返回 409；幂等记录和首个业务写入在同一事务提交，外部副作用再由 operation_id 保护。

## 3. 总体关系

~~~mermaid
erDiagram
  AGENT ||--o{ AGENT_REVISION : has
  RUNTIME ||--o{ RUNTIME_REVISION : has
  AGENT_REVISION ||--o{ DEPLOYMENT_ROUTE : routed_by
  RUNTIME_REVISION ||--o{ DEPLOYMENT_ROUTE : serves

  AGENT ||--o{ THREAD : primary_agent
  THREAD ||--o{ TURN : contains
  THREAD ||--o{ THREAD_ITEM : projects
  THREAD ||--o{ THREAD_EVENT : records
  THREAD ||--o{ PENDING_INPUT : queues
  THREAD ||--o{ THREAD_RELATION : relates
  JOB ||--o{ JOB_EVENT : records
  JOB ||--o{ JOB_COMMAND : controls

  TURN ||--o{ INVOCATION : executes
  JOB ||--o{ INVOCATION : executes
  JOB ||--o{ JOB_RESULT_PROJECTION : publishes
  JOB_RESULT_PROJECTION ||--|| THREAD_ITEM : projects
  INVOCATION ||--o{ INVOCATION_ATTEMPT : retries
  INVOCATION ||--|| EXECUTION_BINDING : freezes
  INVOCATION ||--o{ CAPABILITY_USE : uses
  INVOCATION ||--o{ TOOL_CALL : calls
  TOOL_CALL ||--o| EFFECT_RECORD : affects
  TOOL_CALL ||--o{ PERMISSION_DECISION : decides
  TOOL_CALL ||--o{ USER_ACTION_REQUEST : waits
  INVOCATION ||--o{ MEMORY_CANDIDATE : proposes
  MEMORY_CANDIDATE }o--o| MEMORY_ENTRY : resolves_to

  WORKSPACE ||--o{ WORKSPACE_BINDING : locates
  THREAD ||--o{ WORKSPACE_ATTACHMENT : attaches
  ENVIRONMENT_DEFINITION ||--o{ ENVIRONMENT_LEASE : allocates
  EXECUTION_BINDING }o--|| ENVIRONMENT_LEASE : runs_in

  THREAD_ITEM }o--o| ARTIFACT : references
  TOOL_CALL ||--o{ FILE_CHANGE : produces
~~~

## 4. 控制与配置表

### 4.1 `agent`

稳定 Agent 身份，是 Harness 可治理、可调用的一类智能体资产；它不是唯一可运行资产，也不是 Thread/Route/Binding 的存在前置（Agent 表为空是合法状态）。

| 字段 | 类型 | 必填 | 约束与说明 |
|---|---|---:|---|
| id | CHAR(36) | 是 | 主键 |
| tenant_id | CHAR(36) | 是 | 租户 |
| agent_key | VARCHAR(128) | 是 | 租户内稳定唯一键 |
| display_name | VARCHAR(256) | 是 | 员工和后台显示名 |
| description | TEXT | 否 | 介绍，不存系统指令 |
| owner_user_id | CHAR(36) | 是 | 负责人 |
| lifecycle_state | VARCHAR(32) | 是 | draft、enabled、disabled、retired |
| current_revision_id | CHAR(36) | 否 | 当前发布修订的逻辑外键 |
| visibility_policy_id | CHAR(36) | 否 | 员工使用范围 |
| version_no | BIGINT | 是 | 乐观并发版本 |
| created_at / updated_at / deleted_at | DATETIME(3) | 是/是/否 | 生命周期时间 |

索引与约束：`UNIQUE(tenant_id, agent_key)`；`INDEX(tenant_id, lifecycle_state, updated_at)`；current_revision 必须属于同一 agent。

### 4.2 `agent_revision`

| 字段 | 类型 | 必填 | 约束与说明 |
|---|---|---:|---|
| id | CHAR(36) | 是 | 主键 |
| agent_id | CHAR(36) | 是 | 所属 Agent |
| revision_no | BIGINT | 是 | Agent 内单调递增 |
| source_type | VARCHAR(32) | 是 | code、agent_yaml、veadk |
| source_revision | VARCHAR(128) | 是 | Git commit 或制品修订 |
| instruction_hash | VARCHAR(128) | 是 | 指令内容 hash |
| agent_artifact_ref | VARCHAR(512) | 是 | Agent 代码/agent.yaml 制品；由 Runtime 加载，不是 Runtime 主机镜像 |
| model_policy_json | JSON | 是 | 默认模型策略 |
| permission_requirements_json | JSON | 是 | 权限要求 |
| delegation_policy_json | JSON | 是 | 委派范围 |
| agent_interface_requirements_json | JSON | 是 | 分开记录 required 与 optional 注入接口，如 dynamic_tools、steer；不代表 Runtime 实际能力 |
| revision_state | VARCHAR(32) | 是 | draft、published、withdrawn |
| created_by / created_at / published_at | CHAR(36)/DATETIME(3) | 是/是/否 | 发布信息 |

索引与约束：`UNIQUE(agent_id, revision_no)`；published 后业务内容不可修改，只能新建修订。

### 4.3 `runtime`、`runtime_revision` 与 `deployment_route`

| 表 | 核心字段 | 关键约束 |
|---|---|---|
| runtime | id、tenant_id、runtime_key、display_name、runtime_kind、owner_user_id、lifecycle_state、current_revision_id、version_no | `UNIQUE(tenant_id, runtime_key)`；runtime_kind 为 hosted、external |
| runtime_revision | id、runtime_id、revision_no、protocol_type、endpoint_ref、runtime_artifact_ref、runtime_capabilities_json、identity_mode、network_zone、config_hash、revision_state、created_at | Runtime 主机/Adapter 制品与实际能力；`UNIQUE(runtime_id, revision_no)`；发布后不可改 |
| deployment_route_set | id、tenant_id、agent_id、route_scope_key、route_scope_json、version_no、updated_at | `UNIQUE(tenant_id, agent_id, route_scope_key)`；一组路由共用 ETag 和聚合锁 |
| deployment_route | id、route_set_id、agent_revision_id、runtime_revision_id、traffic_weight、priority_no、route_state、effective_from、effective_until | 同一 RouteSet 的有效权重总和在锁定 RouteSet 后校验；更新不影响已开始 Invocation |

`endpoint_ref` 只引用受管连接，不直接保存带 Secret 的 URL。外部 Runtime 必须声明身份、事件、取消和能力协议。路由发布要求 Agent 的 required capabilities 是 Runtime capabilities 的子集；optional 能力只影响功能可用性，不阻断发布。Agent 制品变化生成 AgentRevision，Runtime 主机/Adapter 制品或实际能力变化生成 RuntimeRevision。

业务例子：新 Revision 灰度 10% 时新增或更新 DeploymentRoute；不会把 Runtime 配置复制进 AgentRevision，也不会修改正在执行的 ExecutionBinding。

### 4.4 能力和治理表

| 表 | 作用 | 核心字段 |
|---|---|---|
| skill | 稳定 Skill 身份 | id、tenant_id、skill_key、owner_user_id、current_version_id、visibility_scope、lifecycle_state |
| skill_version | 不可变 Skill 内容 | id、skill_id、version_no、content_ref、content_hash、manifest_json、revision_state、created_at |
| tool_provider | 协议中立的能力提供方 | id、tenant_id、provider_key、provider_type、connection_id、trust_level、lifecycle_state |
| tool | 稳定 Tool 身份 | id、provider_id、tool_key、display_name、risk_class、current_schema_revision_id、lifecycle_state |
| tool_schema_revision | Tool 描述与 Schema | id、tool_id、revision_no、description、input_schema_json、output_schema_json、schema_hash、risk_metadata_json、created_at |
| connection | 外部连接元数据 | id、tenant_id、connection_key、connection_type、endpoint_ref、auth_method、owner_user_id、lifecycle_state |
| credential_ref | Secret 引用 | id、tenant_id、provider、vault_ref、fingerprint、scope_json、expires_at、lifecycle_state；无密文 |
| policy_set | 稳定策略身份 | id、tenant_id、policy_key、owner_user_id、current_revision_id、lifecycle_state |
| policy_revision | 不可变策略 | id、policy_set_id、revision_no、rules_ref、rules_hash、revision_state、created_at |
| knowledge_base | 知识集合 | id、tenant_id、knowledge_key、owner_user_id、visibility_policy_id、index_state、lifecycle_state |
| knowledge_document | 稳定文档身份 | id、knowledge_base_id、source_ref、current_revision_id、lifecycle_state |
| knowledge_document_revision | 文档修订 | id、document_id、revision_no、content_ref、content_hash、acl_snapshot_hash、index_state、created_at |

Tool Schema 新修订在调用开始前解析；高风险差异进入能力负责人或安全审核，不触发所有 Agent 重发。

### 4.5 `catalog_entry` 读模型

统一目录只建立可重建的查询投影：

| 字段 | 说明 |
|---|---|
| resource_type / resource_id | Agent、Skill、Tool、Knowledge、Runtime、Model、Connection |
| tenant_id | 租户 |
| display_name / description | 搜索文本 |
| owner_user_id / tags_json | 负责人和标签 |
| lifecycle_state / visibility_summary | 展示状态和可见范围摘要 |
| source_updated_at / projected_at | 投影新鲜度 |
| catalog_revision | 租户与受众维度的单调目录修订，用于缓存失效；不是能力版本 |

`catalog_entry` 没有通用更新 API。写入 Agent、Skill 或 Tool 后由投影器刷新。

## 5. 会话交互表

### 5.1 `thread`

| 字段 | 类型 | 必填 | 约束与说明 |
|---|---|---:|---|
| id | CHAR(36) | 是 | 主键 |
| tenant_id | CHAR(36) | 是 | 租户 |
| owner_user_id | CHAR(36) | 是 | 会话所有者 |
| default_workspace_id | CHAR(36) | 否 | 默认逻辑 Workspace |
| active_goal_id | CHAR(36) | 否 | 当前 Goal |
| title | TEXT | 否 | 首个 Turn 前可为空，生成后更新 |
| default_model_ref | VARCHAR(256) | 否 | 员工下一次新 Invocation 的模型偏好；实际值仍写 ExecutionBinding |
| default_environment_definition_id | CHAR(36) | 否 | 默认环境偏好，不是实际 Lease |
| lifecycle_state | VARCHAR(32) | 是 | active、archived、deleted |
| last_activity_at | DATETIME(3) | 是 | 列表排序 |
| last_turn_sequence | BIGINT | 是 | Turn 序号分配基线 |
| last_item_sequence | BIGINT | 是 | Item 序号分配基线 |
| last_event_sequence | BIGINT | 是 | Event 序号分配基线 |
| pending_queue_version_no | BIGINT | 是 | PendingInput 全队列并发版本 |
| version_no | BIGINT | 是 | 并发更新 |
| created_at / updated_at / deleted_at | DATETIME(3) | 是/是/否 | 生命周期时间 |

索引：`INDEX(tenant_id, owner_user_id, lifecycle_state, last_activity_at DESC)`。

### 5.2 `thread_relation`

| 字段 | 类型 | 必填 | 说明 |
|---|---|---:|---|
| id | CHAR(36) | 是 | 主键 |
| parent_thread_id / child_thread_id | CHAR(36) | 是 | 父子 Thread |
| relation_type | VARCHAR(32) | 是 | delegate、fork、workflow_child；handoff 不创建第二个 Thread |
| source_turn_id / source_item_id / source_invocation_id | CHAR(36) | 否 | 关系产生位置；delegate 必须有 source_invocation_id |
| target_agent_id | CHAR(36) | 否 | delegate 目标 Agent；Thread 不保存主 Agent，fork 不继承主 Agent |
| task_payload_ref / task_payload_hash | VARCHAR(512)/VARCHAR(128) | 否 | 结构化任务说明，不复制父 Thread 全文 |
| context_transfer_policy_json | JSON | 否 | task_only、recent、full 及允许的 Item/Artifact 引用 |
| budget_policy_json | JSON | 否 | Token、费用、ToolCall、并发和深度上限 |
| relation_state | VARCHAR(32) | 是 | creating、active、cancel_requested、completed、failed、cancelled |
| item_id | CHAR(36) | 否 | 员工可见 ChildThread Item；一对一 |
| result_item_id | CHAR(36) | 否 | 回传父 Thread 的结果 Item |
| result_ref / result_hash | VARCHAR(512)/VARCHAR(128) | 否 | 子 Thread 终态结果和不可变摘要 |
| created_at / completed_at | DATETIME(3) | 是/否 | 时间 |

约束：`UNIQUE(parent_thread_id, child_thread_id, relation_type)`、非空 `item_id` 和 `result_item_id` 分别唯一；parent 与 child 不能相同；跨租户禁止；delegate 的 child Thread 创建、relation、父 child_thread Item 和两条 ThreadEvent 必须由应用服务原子协调，Runtime 不能直写。

### 5.3 `turn`

| 字段 | 类型 | 必填 | 约束与说明 |
|---|---|---:|---|
| id | CHAR(36) | 是 | 主键 |
| thread_id | CHAR(36) | 是 | 所属 Thread |
| turn_sequence | BIGINT | 是 | Thread 内单调递增 |
| trigger_type | VARCHAR(32) | 是 | user_message、thread_schedule、thread_webhook、job_result_projection、system |
| trigger_ref | VARCHAR(256) | 否 | 外部触发引用或计划 id |
| trigger_item_id | CHAR(36) | 否 | 用户触发时指向 user_message Item |
| turn_state | VARCHAR(32) | 是 | accepted、queued、running、waiting_user、regenerating、completed、interrupted、failed、cancelled |
| active_invocation_id | CHAR(36) | 否 | 当前 queued/running/waiting 的执行；终态为空 |
| latest_invocation_id | CHAR(36) | 否 | 最近创建的执行，包含失败的 Regenerate |
| adopted_invocation_id | CHAR(36) | 否 | 当前 final_item 所属会话执行；系统投影结果或无有效结果时为空 |
| final_item_id | CHAR(36) | 否 | 当前正式回答或结果 |
| error_code | VARCHAR(128) | 否 | 稳定错误码 |
| regeneration_no | BIGINT | 是 | 显式 Regenerate 次数，默认 0 |
| regeneration_base_state | VARCHAR(32) | 否 | regenerating 期间保存 completed、interrupted 或 failed，结束后清空 |
| accepted_at / started_at | DATETIME(3) | 是/否 | 起始时间 |
| waiting_at / finished_at | DATETIME(3) | 否 | 等待与终态时间 |
| version_no | BIGINT | 是 | 状态并发更新 |

索引与约束：`UNIQUE(thread_id, turn_sequence)`；`INDEX(thread_id, turn_state, accepted_at)`。waiting_user 可恢复；completed/interrupted/failed 只有专用 Regenerate 命令可原子进入 regenerating，cancelled 不可恢复。Regenerate 失败且已有 adopted result 时恢复 completed；没有时恢复 regeneration_base_state。失败的新 Invocation 仍是 latest，但不是 adopted。只有 trigger_type=job_result_projection 的 Turn 可无 Invocation 从 accepted 直接 completed，此时 active/latest/adopted 全为空。

### 5.4 `thread_item`

| 字段 | 类型 | 必填 | 约束与说明 |
|---|---|---:|---|
| id | CHAR(36) | 是 | 主键 |
| thread_id | CHAR(36) | 是 | 所属 Thread |
| turn_id | CHAR(36) | 是 | Item 必须属于 Turn；Thread 级变化只写 ThreadEvent |
| item_sequence | BIGINT | 是 | Thread 内稳定展示顺序 |
| item_type | VARCHAR(64) | 是 | user_message、user_guidance、agent_message、tool_call、artifact、job_result 等 |
| item_state | VARCHAR(32) | 是 | pending、completed、failed、superseded、cancelled |
| author_type / author_id | VARCHAR(32)/CHAR(36) | 是/否 | user、agent、system、tool |
| content_json | JSON | 是 | 按 item_type 验证的当前内容或引用 |
| content_hash | VARCHAR(128) | 是 | 内容 hash |
| context_policy | VARCHAR(32) | 是 | include、summary_only、exclude、sensitive |
| invocation_id | CHAR(36) | 否 | 产生该 Item 的执行 |
| superseded_by_item_id | CHAR(36) | 否 | 被替代关系 |
| created_at / updated_at | DATETIME(3) | 是 | 时间 |

索引与约束：`UNIQUE(thread_id, item_sequence)`；`INDEX(thread_id, turn_id, item_sequence)`；`INDEX(invocation_id)`；`superseded_by_item_id` 不得形成环。

执行领域对象上的唯一 `item_id` 是类型化 Item 关系的权威方向，ThreadItem 不再保存不可校验的多态反向引用：

- tool_call Item 关联 `tool_call`。
- user_action_request Item 关联 `user_action_request`。
- artifact Item 关联 `artifact`。
- child_thread Item 关联 `thread_relation`。
- job_result Item 关联 `job_result_projection`。

这些 item_id 都必须建立真实外键和唯一约束，并校验目标 Item 的 thread_id、turn_id、invocation_id 与领域对象一致。

### 5.5 `thread_event`

| 字段 | 类型 | 必填 | 约束与说明 |
|---|---|---:|---|
| id | CHAR(36) | 是 | 全局事件 id，用于关联和审计 |
| thread_id | CHAR(36) | 是 | 所属 Thread |
| event_sequence | BIGINT | 是 | Thread 内单调递增，续读主游标 |
| event_type | VARCHAR(128) | 是 | 稳定事件名 |
| schema_version | SMALLINT | 是 | payload 版本 |
| turn_id / item_id / invocation_id | CHAR(36) | 否 | 关联对象 |
| actor_type / actor_id | VARCHAR(32)/CHAR(36) | 是/否 | 事件发起者 |
| payload_json | JSON | 是 | 类型化且已脱敏的负载 |
| correlation_id / causation_id | CHAR(36) | 否 | 关联与因果 |
| idempotency_key | VARCHAR(128) | 否 | 生产者幂等键 |
| occurred_at / ingested_at | DATETIME(3) | 是 | 发生与接收时间 |

索引与约束：

- `UNIQUE(thread_id, event_sequence)`。
- 非空时 `UNIQUE(thread_id, idempotency_key)`。
- `INDEX(thread_id, occurred_at, id)`、`INDEX(turn_id, event_sequence)`、`INDEX(invocation_id, event_sequence)`。
- Event 只允许 INSERT；数据库账号和仓储层都禁止 UPDATE/DELETE，保留策略清理除外。

SSE 的 `id` 直接使用十进制 event_sequence，Event envelope 仍返回 UUID event_id。这样即使旧 Event 已清理，`Last-Event-ID` 仍可与最早可用 sequence 比较，不依赖已删除的 UUID 映射。

### 5.6 `pending_input`

| 字段 | 类型 | 必填 | 说明 |
|---|---|---:|---|
| id | CHAR(36) | 是 | 主键 |
| thread_id / author_user_id | CHAR(36) | 是 | 会话和作者 |
| client_message_id | VARCHAR(128) | 是 | 客户端重发幂等键 |
| queue_position | DECIMAL(20,10) | 是 | 可排序位置；后台按需重平衡 |
| input_state | VARCHAR(32) | 是 | pending、admitted、removed |
| content_json / content_hash | JSON/VARCHAR(128) | 是 | 输入内容和 hash |
| admitted_turn_id | CHAR(36) | 否 | 正式接纳后指向 Turn |
| admitted_item_id | CHAR(36) | 否 | 接纳后指向 user_message 或 user_guidance Item |
| version_no | BIGINT | 是 | 单条编辑 ETag |
| created_at / updated_at / removed_at | DATETIME(3) | 是/是/否 | 时间 |

约束：`UNIQUE(thread_id, client_message_id)`；只有 pending 可编辑、删除或排序；admitted 后内容不可改。重排必须同时校验并递增 Thread.pending_queue_version_no。

### 5.7 `goal`

`goal` 包含 id、thread_id、objective、success_criteria_json、constraints_json、current_state_json、goal_state、created_by、created_at、updated_at、completed_at。生成列 `active_thread_id = IF(goal_state='active', thread_id, NULL)` 并加 `UNIQUE(active_thread_id)`，保证一个 Thread 最多一个 active Goal。

## 6. 执行表

### 6.1 `job`

| 字段 | 类型 | 必填 | 约束与说明 |
|---|---|---:|---|
| id / tenant_id | CHAR(36) | 是 | 主键和租户 |
| agent_id | CHAR(36) | 是 | 执行 Agent 稳定身份 |
| job_type | VARCHAR(32) | 是 | scheduled、batch、deployment、evaluation、knowledge_build、system |
| trigger_ref | VARCHAR(256) | 否 | 计划、Webhook、批次或上游任务引用 |
| job_state | VARCHAR(32) | 是 | queued、running、waiting_external、completed、failed、cancelled |
| replaces_job_id | CHAR(36) | 否 | 显式重新运行时指向同租户同类型的终态 Job；原 Job 不复活 |
| completion_policy_json | JSON | 是 | all_success、fail_fast、threshold 或类型化自定义条件 |
| thread_id | CHAR(36) | 否 | 仅当结果需要进入员工会话时关联 |
| last_event_sequence | BIGINT | 是 | JobEvent 连续分配游标，初始为 0 |
| result_ref | VARCHAR(512) | 否 | 最终结果或 Artifact 集合引用；不冒充 Thread Item |
| created_by / created_at / started_at / finished_at | CHAR(36)/DATETIME(3) | 是/是/否/否 | 生命周期 |
| version_no | BIGINT | 是 | 并发状态版本 |

`job_event` 包含 id、job_id、event_sequence、event_type、schema_version、invocation_id、actor_type/id、correlation_id、causation_id、idempotency_key、payload_json、occurred_at；`UNIQUE(job_id, event_sequence)`、`UNIQUE(job_id, idempotency_key)`。Job 更新与 `last_event_sequence` 分配在同一事务完成。核心类型包括 job.queued/started/progress_updated/result_recorded/waiting/cancel_requested/completed/failed/cancelled 和 job.invocation_*。单个 Invocation 终态只写 job.invocation_*；调度器按 completion_policy_json 判断整个 Job 终态后才写 job.completed/failed/cancelled。JobEvent 不出现在员工 Thread SSE；需要展示的结果通过显式 Turn/Item 命令进入 Thread。

### 6.2 `invocation`

| 字段 | 类型 | 必填 | 约束与说明 |
|---|---|---:|---|
| id | CHAR(36) | 是 | 主键 |
| tenant_id | CHAR(36) | 是 | 租户 |
| thread_id / turn_id | CHAR(36) | 否 | 会话执行时同时存在 |
| job_id | CHAR(36) | 否 | 后台执行时存在 |
| invocation_sequence | BIGINT | 是 | 所属 Turn 或 Job 内递增 |
| invocation_kind | VARCHAR(32) | 是 | initial、regenerate、job |
| execution_state | VARCHAR(32) | 是 | queued、running、waiting_user、completed、failed、cancelled、lost |
| trigger_item_id | CHAR(36) | 否 | 输入 Item |
| replaces_invocation_id | CHAR(36) | 否 | Regenerate 替代关系 |
| output_item_id | CHAR(36) | 否 | 会话 Invocation 的当前输出 Item；Job Invocation 为空 |
| result_ref | VARCHAR(512) | 否 | Job Invocation 的结果或 Artifact 引用；会话执行通常为空 |
| runtime_session_binding_id | CHAR(36) | 否 | 外部 Runtime 的稳定 Thread/Session 映射 |
| runtime_execution_ref | VARCHAR(256) | 否 | 初始 Runtime 执行句柄，按 RuntimeRevision 解释 |
| started_at / finished_at / last_heartbeat_at | DATETIME(3) | 否 | 执行时间 |
| error_code / error_summary | VARCHAR(128)/TEXT | 否 | 脱敏错误 |
| version_no | BIGINT | 是 | 状态并发更新 |

约束：turn_id 与 job_id 恰有一个非空；会话 Invocation 的 thread_id 必须与 Turn 一致，Job Invocation 的 thread_id 只可继承 Job.thread_id；分别 `UNIQUE(turn_id, invocation_sequence)`、`UNIQUE(job_id, invocation_sequence)`。Regenerate 必须指向同一 Turn 的 Invocation。

### 6.3 `invocation_attempt`

| 字段 | 说明 |
|---|---|
| id | 独立主键，供 Lease 和命令引用 |
| invocation_id / attempt_no | 所属 Invocation；1 表示第一次基础设施重试，联合唯一 |
| attempt_state | queued、running、completed、failed、cancelled、lost |
| environment_lease_id | 本次重新调度获得的实际 Lease |
| worker_ref / runtime_execution_ref | 执行节点和新的 Runtime 句柄 |
| checkpoint_ref | 恢复起点；必须避开已确认副作用 |
| retry_reason_code | 只有重试 Attempt 才有 |
| started_at / finished_at / last_heartbeat_at | 时间 |
| error_code / error_summary | 脱敏错误 |

约束：`UNIQUE(invocation_id, attempt_no)`。没有真实基础设施重试时不写 Attempt 行。单个模型请求重试保存在 Model Span，Tool 重试保存在 ToolCall/Effect；只有整个 Invocation 重新调度才新增 Attempt。

### 6.4 `execution_binding`

一条 Invocation 恰有一条不可变绑定：

| 字段 | 必填 | 说明 |
|---|---:|---|
| invocation_id | 是 | 主键兼外键 |
| agent_revision_id | 是 | 实际 Agent 代码和指令 |
| runtime_revision_id | 是 | 实际 Runtime 制品或协议配置 |
| deployment_route_id | 是 | 当时命中的路由 |
| model_provider / model_id / model_revision_ref | 是/是/否 | 实际模型引用 |
| initial_environment_lease_id | 是 | 首次执行实例；重试 Lease 写 invocation_attempt |
| workspace_binding_id | 否 | 默认实际工作位置 |
| policy_revision_id | 是 | 启动时主要策略修订 |
| context_checkpoint_id | 否 | 上下文组装或压缩点引用 |
| config_hash | 是 | 绑定字段规范化后的 hash |
| bound_at | 是 | 绑定时间 |

不得在 Invocation 运行中更新该行。能力动态使用另记 `capability_use`。

### 6.5 `capability_use`

| 字段 | 说明 |
|---|---|
| invocation_id | 所属执行 |
| capability_type | skill、tool、knowledge_document、memory、agent、model |
| capability_id | 稳定资源 id |
| revision_id | 实际修订，可为空 |
| content_hash / schema_hash | 实际内容或 Schema hash |
| source_type / source_ref | default、dynamic_discovery、user_selected、policy 等来源 |
| selection_reason_code | 可检索的选择原因；详细自然语言进入 Trace |
| first_used_at | 首次实际进入上下文或调用的时间 |

写入时生成 `capability_use_key=sha256(type|id|revision-or-empty|content-hash-or-empty|schema-hash-or-empty)`，使用 `UNIQUE(invocation_id, capability_use_key)`，避免 MySQL NULL 破坏去重。它记录实际使用，不记录仅被列出但未加载的候选。

### 6.6 `tool_call`

| 字段 | 类型 | 必填 | 说明 |
|---|---|---:|---|
| id | CHAR(36) | 是 | 主键 |
| invocation_id | CHAR(36) | 是 | 所属执行；通过 Invocation 判断归属 Turn 或 Job |
| thread_id / turn_id / job_id | CHAR(36) | 否 | 查询冗余；必须与 Invocation 归属一致，Turn 与 Job 二选一 |
| call_sequence | BIGINT | 是 | Invocation 内递增 |
| tool_id / tool_schema_revision_id | CHAR(36) | 是 | 稳定 Tool 与固定 Schema |
| schema_hash | VARCHAR(128) | 是 | 调用时 Schema hash |
| call_state | VARCHAR(32) | 是 | proposed、paused、running、succeeded、failed、cancelled、unknown_effect |
| operation_id | VARCHAR(128) | 是 | 稳定业务操作幂等 id |
| arguments_redacted_json / arguments_hash | JSON/VARCHAR(128) | 是 | 脱敏参数与原参数 hash |
| environment_lease_id | CHAR(36) | 是 | 实际执行环境 |
| result_summary_json / result_artifact_id | JSON/CHAR(36) | 否 | 小结果或大结果引用 |
| item_id | CHAR(36) | 否 | 员工可见 ToolCall Item；一对一 |
| started_at / finished_at | DATETIME(3) | 否 | 时间 |
| error_code / error_summary | VARCHAR(128)/TEXT | 否 | 脱敏错误 |

约束：`UNIQUE(invocation_id, call_sequence)`；`UNIQUE(tool_id, operation_id)`；非空 item_id 必须唯一并引用同一 thread/turn/invocation 的 tool_call Item。同一 operation_id 携带不同 arguments_hash 返回冲突。会话 ToolCall 同时有 thread_id、turn_id 且 job_id 为空，纯 Job ToolCall 只有 job_id；参数中的平台身份和 Credential 不由模型提供。

### 6.7 `effect_record` 与 `effect_target`

一条有副作用 ToolCall 有一条总 EffectRecord；批量或多目标结果拆到 EffectTarget，并通过 Event 保留变化：

| 字段 | 说明 |
|---|---|
| id / tool_call_id | 主键与唯一 ToolCall 外键 |
| effect_type | create、update、delete、send、payment、deploy 等 |
| target_summary_json | 目标数量和脱敏摘要 |
| effect_state | not_started、confirmed_success、confirmed_partial、confirmed_failure、unknown_effect |
| external_idempotency_key | 目标系统幂等键 |
| external_result_ref | 外部结果引用 |
| verification_method / verified_at | 核对方式和时间 |
| evidence_json | 不含 Secret 的证据摘要 |

`effect_target` 包含 id、effect_record_id、target_ref/hash、target_state、external_result_ref、verified_at、evidence_json；target_state 为 confirmed_success、confirmed_failure 或 unknown，且 `UNIQUE(effect_record_id, target_hash)`。总 effect_state 由目标明细和外部核对结果决定，可表达 86 个目标中的部分成功。Effect 核对确认后，ToolCall 从 unknown_effect 同步转为 succeeded（success/partial）、failed（failure）或继续 unknown_effect；`unknown_effect` 不能自动重试，必须先查询目标系统或等待人工处理。

### 6.8 `permission_decision`、`user_action_request` 与 `grant`

| 表 | 核心字段 | 约束 |
|---|---|---|
| permission_decision | id、tool_call_id、decision_sequence、policy_revision_id、decision、reason_codes_json、risk_summary_json、decided_at | decision 为 allow、pause、block；`UNIQUE(tool_call_id, decision_sequence)` |
| user_action_request | id、thread_id、turn_id、invocation_id、tool_call_id、item_id、request_type、purpose、request_state、prompt_json、input_schema_json、auth_state_hash、nonce_hash、expires_at、resolution、resolved_by、response_redacted_json、grant_id、created_at、resolved_at | request_type 为 confirmation、auth、grant、input；purpose 可标识 handoff 等业务意图；item_id 唯一并校验同一 thread/turn/invocation；只能解析一次；auth callback 同时校验 state 与 nonce |
| grant | id、tenant_id、user_id、grant_type、scope_json、credential_ref_id、issued_by、issued_at、expires_at、revoked_at | Scope 必须覆盖当前 ToolCall，撤销后不可注入 |

### 6.9 `runtime_event_ingress`

Runtime 候选事件先进入幂等接收账本，再映射为 Item mutation 和 ThreadEvent/JobEvent：

| 字段 | 说明 |
|---|---|
| id / invocation_id | 主键与所属 Invocation |
| producer_event_id / producer_sequence | Runtime 稳定事件 id 和连续序号 |
| candidate_type / schema_version | Runtime Protocol 候选事件类型 |
| payload_hash | 原候选负载 hash；正文按采集策略短期保存或对象引用 |
| ingress_state | accepted、mapped、rejected |
| mapped_item_id / mapped_thread_event_id / mapped_job_event_id | 确定性映射结果 |
| received_at / mapped_at | 时间 |

约束：`UNIQUE(invocation_id, producer_event_id)`、`UNIQUE(invocation_id, producer_sequence)`。重新分批或部分重放返回原映射；相同 id/sequence 但 payload_hash 不同直接拒绝。可重试的 Schema/大小错误不写 ingress 行、不消费序号，Runtime 可用同一 sequence 和新 producer_event_id 修正；身份、租户、hash 冲突等不可修复错误原子终止 Invocation 并写 terminal rejection。批次响应的 accepted_through_sequence 由连续 mapped 行计算。Invocation 重新调度时平台把下一个连续序号作为 `producer_sequence_start` 传给 Runtime，序号在整个 Invocation 内连续，不能按 Attempt 从 1 重启。

### 6.10 `invocation_command`

平台向 Runtime 发送的 cancel、resume、steer 使用持久命令表：id、invocation_id、command_type、command_payload_ref/hash、command_state、runtime_execution_ref、idempotency_key、created_at、dispatched_at、acknowledged_at、error_code。`UNIQUE(invocation_id, idempotency_key)`；UserAction resolve 与 resume command 在同一数据库事务写入，Runtime 确认后才把 Turn/Invocation 从 waiting_user 改为 running。

### 6.11 `runtime_session_binding`

外部 Runtime 自己维护 Session/Conversation 时，平台保存 id、tenant_id、runtime_revision_id、thread_id/job_id、external_session_ref、binding_state、created_at、last_used_at、closed_at。Thread 与 Job 恰有一个非空；`UNIQUE(runtime_revision_id, external_session_ref)`。Invocation 引用该 Binding，Adapter 重启后仍能 resume/cancel/fork；外部 Session 不取代 SnowHarness Thread/Job。

### 6.12 `job_command`

Job 的 cancel、retry 使用持久命令表：id、tenant_id、job_id、command_type、command_state、idempotency_key、requested_by、reason_code、replacement_job_id、created_at、dispatched_at、acknowledged_at、error_code。`command_type` 为 cancel、retry；`command_state` 为 queued、dispatched、acknowledged、rejected。`UNIQUE(job_id, idempotency_key)`。

cancel 命令只先写 `job.cancel_requested`，不能提前修改为 cancelled。retry 只接受 completed、failed、cancelled Job，且在同一事务创建新的 Job、写入 `replaces_job_id`、填充 replacement_job_id 并完成命令；不能复用旧 Job id。Job 类型所属领域服务负责验证原始参数仍可使用，Runtime 不能调用通用 Job 创建接口。

### 6.13 `execution_ownership` 与 `environment_change_request`

| 表 | 核心字段 | 关键规则 |
|---|---|---|
| execution_ownership | invocation_id、device_id、environment_lease_id、ownership_state、lease_epoch、acquired_at、last_heartbeat_at、released_at | 一个活跃 Invocation 只有一个 active ownership；`UNIQUE(invocation_id, lease_epoch)`；打开同一 Thread 不获得执行权 |
| environment_change_request | id、thread_id、invocation_id、from_environment_definition_id、requested_environment_definition_id、requested_device_id、request_state、reason_code、requested_by、created_at、resolved_at | state 为 pending、accepted_for_next_invocation、runtime_acknowledged、rejected、expired；当前 Invocation 迁移必须由 Runtime 明确支持并 ack |

业务例子：员工在 Web 打开由 Desktop 执行的会话，只获得查看和输入权，不会让云端接管本地文件。员工显式请求改到 Cloud 后，不支持热迁移的 Runtime 把变更记录为下一次 Invocation 生效。

## 7. Workspace、环境和内容表

### 7.1 `workspace`、`workspace_binding` 与 `workspace_attachment`

| 表 | 核心字段 | 关键规则 |
|---|---|---|
| workspace | id、tenant_id、owner_user_id、workspace_key、display_name、workspace_kind、lifecycle_state、created_at | 逻辑工作位置，不存跨环境通用绝对路径 |
| workspace_binding | id、workspace_id、binding_type、device_id、environment_definition_id、location_ref、location_fingerprint、binding_state、last_verified_at | Desktop binding 必须同时有 device_id 和 location_ref；Cloud/Remote 使用受管 location_ref |
| workspace_attachment | id、thread_id、workspace_binding_id、resource_type、resource_ref、access_mode、attachment_state、attached_by、version_no、created_at、expires_at | Thread 级受限资源，不改变默认 Workspace；version_no 生成 ETag |
| workspace_attachment_use | turn_id、workspace_attachment_id、created_at | `UNIQUE(turn_id, workspace_attachment_id)`；Turn 只引用已验证且仍有效的 Attachment |

### 7.2 `environment_definition` 与 `environment_lease`

| 表 | 核心字段 |
|---|---|
| environment_definition | id、tenant_id、environment_key、environment_type、filesystem_policy_json、network_policy_json、resource_limits_json、secret_policy_json、lifecycle_state、version_no |
| environment_lease | id、environment_definition_id、invocation_id、attempt_id、device_id、worker_ref、lease_state、capabilities_json、allocated_at、last_heartbeat_at、released_at、expires_at |

environment_type 为 desktop、cloud、remote、sandbox。Desktop ToolCall 使用 WorkspaceBinding 时，binding.device_id 必须等于 lease.device_id，且 environment_definition_id 必须兼容；Lease 失联使 Invocation 进入恢复判断，不删除 Thread 或 Workspace。

### 7.3 `filesystem_checkpoint`

包含 id、workspace_binding_id、invocation_id、checkpoint_type、checkpoint_ref、base_revision_ref、content_hash、created_at、expires_at。它只恢复文件状态，不恢复会话；会话恢复读取 Item 和 Event。

### 7.4 `artifact` 与 `file_change`

| 表 | 核心字段 | 关键规则 |
|---|---|---|
| artifact | id、tenant_id、invocation_id、thread_id、turn_id、job_id、item_id、artifact_type、display_name、content_ref、media_type、byte_size、content_hash、visibility_scope、created_at、expires_at | 内容在对象存储或原 Workspace，表中只保存受控引用和 hash |
| file_change | id、tool_call_id、workspace_binding_id、path_ref、change_type、before_hash、after_hash、artifact_id、created_at | 本地路径必须结合 WorkspaceBinding 和 device 解释 |
| job_result_projection | id、job_id、source_result_ref、source_artifact_id、thread_id、turn_id、item_id、published_by、created_at | Job 结果进入会话的显式投影；source_result_ref/source_artifact_id 至少一个，item_id 唯一，Item 本身 invocation_id 为空 |

Artifact 必须有 invocation_id；非空 item_id 唯一且必须校验同一 thread/turn/invocation。会话产物的 thread_id、turn_id 与 Invocation 一致，Job 产物只填 job_id，不能直接改挂到 Thread Item。发布到会话时新建 `job_result_projection` 和 invocation_id 为空的 job_result Item，保留来源 Artifact/Result 引用。`path_ref` 在 Desktop 环境中必须结合 workspace_binding/device 解释；API 默认返回相对展示路径，不向无权客户端泄露本地绝对路径。

### 7.5 Memory 与知识索引

| 表 | 核心字段 | 关键规则 |
|---|---|---|
| context_checkpoint | id、tenant_id、invocation_id、checkpoint_type、source_ranges_json、source_ranges_hash、summary_ref/summary_redacted、summary_hash、input_tokens、retained_tokens、compressed_tokens、created_at、expires_at | 只保存可恢复的组装/压缩位置，不删除原始 Item/Event，不冒充 FilesystemCheckpoint |
| memory_candidate | id、tenant_id、invocation_id、source_thread_id、source_turn_id、source_item_id、source_job_id、source_artifact_id、proposed_scope_type、proposed_scope_ref、memory_type、content_ref/content_redacted、content_hash、candidate_key、sensitivity_class、candidate_state、decision_reason_codes_json、resolved_memory_entry_id、proposed_at、resolved_at | Runtime 仅可提案；state 为 submitted、accepted、rejected、needs_review、expired |
| memory_entry | id、tenant_id、scope_type、scope_ref、memory_type、content_ref/content_redacted、content_hash、sensitivity_class、memory_state、valid_from、expires_at、created_at、updated_at | Entry 是通过 Policy 接受后的长期事实，不允许 Runtime 直写 |
| memory_source | id、memory_entry_id、memory_candidate_id、source_type、source_id、source_hash、created_at | 一个 Entry 可保留多个可追溯来源；`UNIQUE(memory_entry_id, source_type, source_id, source_hash)` |
| memory_index | memory_entry_id、index_provider、index_ref、embedding_model_ref、content_hash、indexed_at | 索引可重建，不决定 Entry 是否接受 |
| knowledge_chunk | id、document_revision_id、chunk_no、content_ref、content_hash、metadata_json | Chunk 只属于不可变文档修订 |
| knowledge_index | chunk_id、index_provider、index_ref、embedding_model_ref、indexed_at | 索引可重建，权限仍来自 Knowledge 文档 |

约束：`candidate_key=sha256(invocation_id|source_type|source_id|content_hash|scope_type|scope_ref-or-empty)` 并 `UNIQUE(candidate_key)`；source_item_id、source_job_id、source_artifact_id 恰有一个非空，且必须属于同一 Invocation 可访问的来源。accepted 必须有 resolved_memory_entry_id，rejected/expired 不得有。Secret、验证码、Cookie 和 Token 不允许成为 memory_entry；检测命中时 Candidate 直接 rejected，正文按敏感数据策略销毁。

## 8. 观测、评测和审计表

| 表 | 保存什么 | 不保存什么 |
|---|---|---|
| trace_index | trace_id、tenant_id、thread_id、turn_id、job_id、invocation_id、root_span_id、capture_mode、started_at、finished_at、outcome、token/cost summary、storage_ref | 不复制完整 Event/JobEvent 和 Credential |
| evaluation_run | id、tenant_id、agent_revision_id、runtime_revision_id、dataset_revision_id、environment_definition_id、run_state、started_at、finished_at、summary_json | 不修改线上 Invocation |
| evaluation_result | id、evaluation_run_id、case_id、invocation_id、score_json、grader_refs_json、evidence_refs_json、result_state | 不把评分写回业务 Event |
| audit_event | id、tenant_id、actor_type、actor_id、action_type、target_type、target_id、before_hash、after_hash、reason、request_id、occurred_at | 不复制无关聊天正文 |

高量 Span 和日志保存在 Trace 后端；MySQL `trace_index` 只承担关联、筛选和保留策略入口。

### 8.1 投影、交付和坏事件

| 表 | 核心字段 | 关键规则 |
|---|---|---|
| projection_checkpoint | consumer_name、stream_type、shard_key、last_sequence、last_event_id、updated_at、version_no | `PRIMARY KEY(consumer_name, stream_type, shard_key)`；只在投影写入成功的同一事务后前移 |
| event_delivery_failure | id、consumer_name、stream_type、stream_id、event_id、event_sequence、payload_hash、failure_class、attempt_count、next_retry_at、failure_state、last_error_code、created_at、updated_at | state 为 retrying、quarantined、resolved；同一消费者与事件唯一 |
| event_stream_floor | stream_type、stream_id、earliest_available_sequence、latest_sequence、updated_at | SSE 判断 cursor_expired，不查询已删除 Event |

同一流发生不可解析事件时不得跳过并应用后续 sequence。达到重试上限后进入 quarantined，投影显示 degraded；修复映射器或人工确认跳过都必须写 AuditEvent，并以原 sequence 重放。SSE 推送变慢时断开并返回建议重连游标，不为单个慢客户端无限堆积内存。

### 8.2 供应链、授权和数据生命周期

| 表 | 核心字段 | 关键规则 |
|---|---|---|
| artifact_attestation | id、tenant_id、artifact_type、artifact_revision_id、artifact_digest、signature_ref、sbom_ref、provenance_ref、builder_identity、verification_state、verified_at | 同一制品 digest 可多份证明；DeploymentRoute 只引用验证通过且策略允许的制品 |
| role_action_binding | id、tenant_id、principal_binding_id、action_code、resource_scope_json、valid_from、valid_until | action_code 使用固定目录；外部角色只映射，不直接作为服务端权限判断 |
| retention_policy | id、tenant_id、data_class、scope_json、retention_days、delete_mode、legal_basis、policy_state、version_no、effective_from | 同一 scope/data_class 同时只有一个 active 版本 |
| legal_hold | id、tenant_id、hold_key、scope_json、scope_hash、reason_ref、hold_state、effective_at、expires_at、created_by、created_at、released_by、released_at | active Hold 阻止匹配资源物理删除；释放必须校验 scope_hash 并审计 |
| deletion_request | id、tenant_id、subject_type、subject_id、delete_mode、reason_code、policy_revision_id、requested_by、request_state、scope_snapshot_json、blocked_summary_json、created_at、resolved_at | state 为 accepted、planning、blocked_by_hold、deleting、completed、failed |
| deletion_step | id、deletion_request_id、store_type、resource_selector_hash、step_state、attempt_count、evidence_ref、last_error_code、updated_at | 每个存储后端幂等执行；完成需 evidence_ref |

稳定管理动作至少包括 `agent.revision.create`、`agent.publish`、`route.update`、`tool.schema.publish`、`policy.publish`、`credential.bind`、`credential.revoke`、`memory.review`、`job.cancel`、`job.retry`、`event.quarantine.resolve`、`artifact.attestation.verify`、`legal_hold.manage`、`deletion.request` 和 `audit.export`。UI 菜单权限不能代替这些服务端 action_code。

## 9. 事件与投影写入规则

### 9.1 同一数据库事务

以下操作必须同时提交当前状态与 Event：

| 命令 | 当前状态写入 | Event |
|---|---|---|
| 接纳新 Turn 用户输入 | thread_item + turn | item.created、turn.accepted |
| 创建/编辑/重排/删除 PendingInput | pending_input + thread.pending_queue_version_no | pending_input.created/updated/reordered/removed |
| 接纳 Steer 输入 | pending_input=admitted + pending user_guidance Item + invocation_command | pending_input.admitted、item.created、turn.steer_queued；Runtime ack 后写 turn.steered |
| 请求中断 Turn | invocation_command(cancel)，Turn 保持原状态 | turn.interrupt_requested；Runtime 终态 ack 后写 invocation.cancelled + turn.interrupted/cancelled |
| 发起 Regenerate | turn=regenerating + 新 queued invocation；旧 adopted/final 暂时保留 | turn.regeneration_started、invocation.queued |
| 完成 Agent 回答/Regenerate | 新 thread_item + turn/invocation；成功后才切换 adopted/final 并 supersede 旧 Item | item.completed、item.superseded、invocation.completed、turn.completed |
| 发起确认 | user_action_request + turn/invocation | user_action.requested、turn.waiting |
| 解析 UserAction | user_action_request + 类型化结果 + invocation_command(resume) | 总是写 user_action.resolved；confirmation 才追加 permission.decided，grant 才写 grant.issued，auth 由受信回调写 connection 状态，input 只保存脱敏输入；Runtime ack 后另写 turn.resumed、invocation.resumed |
| Effect 核对 | effect_record + effect_target | tool_call.effect_confirmed/failed/unknown/reconciled |
| 切换 Workspace | thread.default_workspace_id | workspace.changed |
| 切换模型/默认 Environment | thread 默认设置 | thread.model_changed、thread.environment_changed |
| 建立 Child Thread | thread + thread_relation | child_thread.created |
| 提交 MemoryCandidate | memory_candidate | memory.candidate_submitted；接受时另写 memory.accepted，拒绝时写 memory.rejected |
| 请求取消 Job | job_command，Job 保持原状态 | job.cancel_requested；调度器确认后写 job.cancelled |
| 重新运行终态 Job | job_command + 新 replacement job | 原 Job 写 job.retry_requested；新 Job 写 job.queued |
| 请求变更执行环境 | environment_change_request | environment_change.requested；Runtime ack 或下一 Invocation 接纳后写 resolved |
| 请求删除 | deletion_request + deletion_step | 管理域 AuditEvent；不写 ThreadEvent 冒充已删除 |

ThreadEvent sequence 通过锁定 Thread.last_event_sequence 原子递增；JobEvent 同理锁定 Job.last_event_sequence。不能先查 max(sequence) 再无锁插入。

### 9.2 Outbox

`thread_event` 和 `job_event` 分别承担各自事件 Outbox。事务提交后投影器和推送服务按流内 id/sequence 消费；消费端记录 checkpoint 并保持幂等。无需再复制一张内容相同的 EventOutbox。

每个消费者必须使用 `projection_checkpoint`；投影更新与 checkpoint 前移使用同一数据库事务，或使用“先幂等写投影、再 CAS 前移 checkpoint”的等价协议。`event_delivery_failure` 保存失败和隔离状态，不能通过日志人工猜测是否漏投。`event_stream_floor` 由保留任务在删除历史 Event 的同一批次更新。

跨域管理事件可使用独立 `domain_outbox`，但不得把它暴露为员工会话 Event。

### 9.3 实时 Delta

模型 Token、心跳和高频 Tool 日志进入短期实时通道：

1. 客户端先按 `transient_id` 展示。
2. 连接中断后从最后持久 Event 恢复。
3. Invocation 完成时写入最终 Item 和持久 Event。
4. 诊断策略要求保留原始流时，压缩后写对象存储并由 Trace 引用，不写数千行 thread_event。

## 10. Schema 权威与 clean migration

`lib/persistence/schema/index.ts` 是唯一 Canonical Root（标准根入口）。`drizzle.config.ts`、`lib/db/client.ts` 和 MySQL 测试基建都直接消费该 Root，不再手工 spread Schema，也不存在第二定义入口。

当前 clean initial migration 为 `drizzle/0000_initial_schema.sql`，从最终 Root 生成 120 张业务表。开发期增量 migration 已删除；该初始迁移不含 rename/drop/backfill 兼容链。Root、Runtime Drizzle、Migration 和 Fresh MySQL 的表名集必须与 `docs/implementation/topic-01-final-closure/71-final-schema-manifest.json` 完全一致。旧 123 表基线中的 `MemoryIndex`、`WorkspaceMergeConflict`、`WorkspaceOverlay` 因无生产读写者已删除。

### 10.1 已删除的第二事实

| 旧表 | 最终处理 | 当前 Authority |
|---|---|---|
| User | merge/delete | UserIdentity + PrincipalBinding |
| AdminAuditLog | merge/delete | AuditEvent（含 outcome 与脱敏 metadata） |
| ToolRun | delete | ToolCall + EffectRecord + Artifact |
| ContextSnapshot / ContextSummary | delete | ContextCheckpoint + Trace/Observation |
| ThreadPlan / ThreadPlanItem | delete | Harness action history + Goal |
| GitCheckpoint | delete | FilesystemCheckpoint |
| McpServerConfig / CustomTool | delete | Connection + ToolProvider + Tool + ToolSchemaRevision |
| SecretMount | delete | CredentialRef + 外部 Credential Provider |
| Deployment | delete | HostedProvisioningRequest + PublicationRecord + RouteActivation + Artifact |
| AuditFailureLog | delete | ControlPlaneOutboxEvent + ControlPlaneEventDelivery / EventDeliveryFailure |

### 10.2 AgentCall 字段 Authority

- exact AgentRevision 只在 `AgentCallBinding.agentRevisionId`。
- A2A contextId 只在 `AgentSessionBinding.externalContextRef`；`AgentCall.agentSessionBindingId` 只是外键。
- A2A taskId 只在 `AgentCall.externalTaskRef`；Attempt 不复制 taskId。

这些边界由 Schema contract test 与 Fresh MySQL manifest test 共同校验，旧 `lib/db/schema.ts`、`lib/db/queries.ts` 及其 writer/consumer 已物理删除。

## 11. 查询读模型

以下读模型可重建，不是权威写表：

| 读模型 | 来源 |
|---|---|
| thread_list_projection | thread + 最近 Item + 未读游标 + 当前 Turn |
| turn_timeline_projection | turn + Item + Event + UserActionRequest |
| actual_execution_record | invocation + attempt + binding + capability_use + tool/effect + permission + 直接关联 Event + trace summary |
| catalog_entry | Agent/Skill/Tool/Knowledge/Runtime/Connection |
| capability_usage_graph | capability_use + child Thread relation |
| admin_risk_queue | permission_decision + user_action_request + audit_event |
| cost_capacity_projection | trace_index + runtime/environment metrics |
| capability_catalog_projection | 各能力当前发布修订 + 可见范围 + 风险摘要；按 tenant/audience 生成 catalog_revision |
| child_thread_summary_projection | thread_relation + 子 Thread 最终 Item/Artifact + 预算使用 |
| job_operations_projection | job + job_command + job_event + Invocation 汇总 |
| event_delivery_health | projection_checkpoint + event_delivery_failure + event_stream_floor |
| deletion_progress_projection | deletion_request + deletion_step + legal_hold |

业务例子：员工会话列表不 join 全部 Event；它读取 thread_list_projection。投影延迟不影响新 Turn 写入，详情页仍可从权威表校正。

## 12. 保留、删除和分区

| 数据 | 保留方式 |
|---|---|
| Agent/Runtime 修订 | 被历史 Invocation 引用时保留不可变摘要；制品按策略归档 |
| Thread/Turn/Item/Event | 按组织会话保留策略；删除先阻止新执行，再异步清理 |
| PendingInput | admitted/removed 后短期保留审计摘要，正文按策略删除 |
| Trace/Span/原始流 | 按 metadata/redacted/diagnostic 分级保留 |
| Credential | 撤销立即停止注入；Vault 按安全策略销毁，业务库保留引用与指纹 |
| Artifact | 按 Thread、Workspace 所有权和独立保留标记处理，不能只因 Thread 删除就误删用户原文件 |
| Knowledge/Memory | 按各自 Scope 和来源删除，不随某个 Thread 无条件级联 |
| MemoryCandidate | 未接受候选短期保存脱敏摘要；敏感拒绝正文立即销毁；接受后按 MemoryEntry 策略 |
| Projection checkpoint/failure | 至少覆盖 Event 最大重放窗口与运维审计窗口 |
| Supply-chain attestation | 被历史 Revision/Invocation 引用的 digest 与验证结论保留；SBOM 正文可归档 |
| Legal Hold / Deletion evidence | Hold 期间保留；释放与删除证明按合规策略独立保存 |

`thread_event`、`audit_event`、Trace 高量数据按 `tenant_id + occurred_at` 做时间分区或冷热分层；具体天数由组织配置。Thread 内 sequence 仍是续读游标，不能用时间戳替代。

## 13. 数据验收

| 场景 | 必须满足的查询结果 |
|---|---|
| Regenerate | 只有一个 user_message Item；Turn 经专用命令进入 regenerating；两个 Invocation；旧 agent_message 指向 superseded_by |
| 模型 503 局部重试 | 一个 Turn、一个 Invocation、零 Attempt；重试只在 Model Span |
| Worker 失联恢复 | 同一 Invocation 新增 Attempt 1，新 EnvironmentLease 归该 Attempt，ExecutionBinding 不变 |
| Tool Schema 更新 | 两次 ToolCall 分别能查到各自 schema_revision/hash |
| Skill 动态更新 | AgentRevision 不变；CapabilityUse hash 随实际读取内容变化 |
| Tool 超时 | EffectRecord 为 unknown_effect，队列中没有自动第二次相同 operation_id 调用 |
| Desktop 本地文件 | WorkspaceBinding 同时包含 device 与 location_ref；云端不能只靠路径访问 |
| SSE 重连 | SSE id 直接使用 event_sequence；快照与 latest_event_cursor 同一一致性读点，无同毫秒事件丢失 |
| 创建命令重放 | idempotency_record 返回同一资源和响应；同 key 不同 request_hash 返回 409 |
| Runtime Event 重新分批或 Attempt 重调度 | producer_event_id/sequence 命中原 ingress 映射；新 Attempt 从平台给定的下一 sequence 继续，不重复创建 Item/ThreadEvent/JobEvent |
| 纯后台评测 | 创建 Job/JobEvent/Invocation，不伪造 Thread/Turn |
| Thread 删除 | Agent、Knowledge、用户原始本地文件不被级联删除 |
| 管理排障 | 由 Actual Execution Record 一次查清 Agent/Runtime/模型/能力/权限/环境/成本 |
| Runtime 提议 Memory | 只新增 memory_candidate；只有 accepted 决策才新增/更新 memory_entry 和索引任务 |
| Child Thread 完成 | 子 Thread 有独立终态；父 Turn 只有一个 relation Item 和不可变 result_ref，不复制子消息 |
| 终态 Job retry | 原 Job 状态和 Event 不变；新 Job.replaces_job_id 指向原 Job |
| 慢 SSE 客户端 | 服务端有界缓冲后断开；客户端用 sequence 重连，最终 Item 不丢 |
| 投影坏事件 | checkpoint 停在坏 sequence 前，后续事件不越序；quarantine 可见并可审计恢复 |
| 两台设备打开同一 Thread | active execution_ownership 不变；第二台设备不会静默迁移 Invocation |
| 删除命中 Legal Hold | deletion_request=blocked_by_hold，所有匹配 deletion_step 未执行物理删除 |
| 未签名 Runtime 制品 | attestation verification_state 非 verified，Route 发布失败且写 AuditEvent |
