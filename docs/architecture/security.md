# 生产运维、安全与数据生命周期

## 1. 结论

进入生产前，Event 不能只定义“怎么写”，还要定义“投不出去怎么办”；Desktop/Web 不能只定义“可继续会话”，还要定义“谁拥有当前执行”；发布不能只校验 Revision id，还要验证制品来源；删除不能只设 `deleted_at`，还要经过保留策略、Legal Hold 和逐存储清理证明。

~~~mermaid
flowchart LR
  Event["ThreadEvent / JobEvent"] --> Projector["Projection Consumer"]
  Projector --> Checkpoint["ProjectionCheckpoint"]
  Projector -->|失败| Failure["DeliveryFailure / Quarantine"]
  Failure --> Repair["修复后按原 sequence 重放"]

  Request["DeletionRequest"] --> Planner["Retention + Legal Hold 解析"]
  Planner -->|允许| Steps["DeletionStep 按存储执行"]
  Planner -->|命中 Hold| Blocked["blocked_by_hold"]
  Steps --> Evidence["删除证明"]
~~~

业务例子：Item 列表投影遇到一个新版本事件无法解析时，checkpoint 停在坏事件之前并进入隔离告警，不能跳过后让员工看到顺序错误的会话。员工删除 Thread 时，系统分别清理 MySQL、对象存储、向量索引和 Trace；共享知识与本地原文件不在删除范围，命中 Legal Hold 的部分保持不动。

## 2. Event 交付与背压

### 2.1 投影消费协议

每个消费者以 `(consumer_name, stream_type, shard_key)` 保存 `projection_checkpoint`，严格遵守：

1. 按流内 sequence 读取，不按 occurred_at 排序。
2. 投影写入必须幂等，幂等键至少包含 consumer、event_id 和 projection target。
3. 投影写入成功后才前移 checkpoint；同数据库使用同一事务，跨存储使用幂等写 + CAS checkpoint。
4. sequence 出现空洞时停止该流并等待，不猜测丢失事件。
5. Schema 不支持、payload hash 冲突或投影约束失败写 `event_delivery_failure`。
6. 可重试错误按指数退避；超过策略阈值进入 quarantined，后续同流事件不得越序生效。
7. 修复后从原 event sequence 重放；人工跳过需要 `event.quarantine.resolve` 权限、理由和 AuditEvent，且只能用于明确声明可忽略的事件类型。

`thread_event` 与 `job_event` 本身就是 Outbox，不再复制同内容表。跨域管理事件使用 `domain_outbox`，不能混入员工 Thread SSE。

### 2.2 SSE 背压与游标

- 每个连接使用可配置的有界缓冲；缓冲耗尽时服务端发送 `stream.backpressure` 临时提示并断开，不无限占内存。
- 持久 SSE `id` 等于十进制 event_sequence。客户端重连提交 `Last-Event-ID`。
- `Last-Event-ID < earliest_available_sequence` 返回 `EVENT_CURSOR_EXPIRED`；客户端先取 Item 快照和 `latest_event_cursor`，再续订。
- 慢客户端断开不影响 Event 持久化和其他消费者；Token delta 可丢，最终 Item/Event 不丢。
- 单租户、用户、Thread 和设备分别配置连接数与事件速率配额；429 返回 `retry_after_ms`，不静默丢持久事件。

业务例子：员工网络暂停两分钟导致客户端消费变慢，SSE 服务断开连接。Desktop 用最后 sequence 重连；若旧事件已过保留窗口，则获取当前 Item 快照再继续，不要求服务端永久保存每个连接的队列。

### 2.3 查询投影交付健康

`GET /admin/api/v1/operations/event-delivery`

| 请求参数 | 位置 | 类型 | 必填 | 说明 |
|---|---|---|---:|---|
| consumer_name | Query | string | 否 | 指定投影消费者 |
| state | Query | string | 否 | healthy、lagging、quarantined |
| tenant_id | Query | string | 否 | 仅平台运维角色可跨租户过滤 |
| cursor | Query | string | 否 | 不透明分页游标 |
| limit | Query | integer | 否 | 1—100，默认 50 |

```bash
curl 'https://snow.example.com/admin/api/v1/operations/event-delivery?state=quarantined&limit=50' \
  -H 'Authorization: Bearer <operations-token>'
```

```json
{
  "items": [
    {
      "consumer_name": "thread_item_projection",
      "stream_type": "thread",
      "stream_id": "thr_01J...",
      "state": "quarantined",
      "checkpoint_sequence": 581,
      "failed_sequence": 582,
      "latest_sequence": 590,
      "lag_events": 9,
      "last_error_code": "EVENT_SCHEMA_UNSUPPORTED",
      "first_failed_at": "2026-07-15T01:40:00.000Z"
    }
  ],
  "next_cursor": null
}
```

响应不返回未授权 Event payload。租户管理员只能看本租户；平台运维跨租户查询必须有独立 action scope 并写审计。

### 2.4 解析隔离事件

`POST /admin/api/v1/operations/event-quarantines/{failure_id}:resolve`

| 请求参数 | 位置 | 类型 | 必填 | 说明 |
|---|---|---|---:|---|
| failure_id | Path | string | 是 | quarantined failure id |
| Idempotency-Key | Header | string | 是 | 解析命令幂等键 |
| resolution | Body | string | 是 | replay、skip |
| expected_payload_hash | Body | string | 是 | 防止处理对象变化 |
| reason_code | Body | string | 是 | MAPPER_DEPLOYED、DATA_REPAIRED、EVENT_DECLARED_IGNORABLE |
| comment | Body | string | 否 | 脱敏说明 |

```bash
curl -X POST 'https://snow.example.com/admin/api/v1/operations/event-quarantines/edf_01J...:resolve' \
  -H 'Authorization: Bearer <operations-token>' \
  -H 'Idempotency-Key: resolve-edf-01J-v1' \
  -H 'Content-Type: application/json' \
  -d '{"resolution":"replay","expected_payload_hash":"sha256:ab...","reason_code":"MAPPER_DEPLOYED","comment":"已发布 schema v2 映射器"}'
```

```json
{
  "failure_id": "edf_01J...",
  "failure_state": "resolved",
  "resolution": "replay",
  "replay_from_sequence": 582,
  "checkpoint_sequence": 581,
  "audit_event_id": "aud_01J..."
}
```

`skip` 只允许机器契约把该 Event type 标为 `skippable_for_projection=true`，并仍记录消费墓碑后才前移 checkpoint；业务终态、权限、副作用和删除事件永不允许 skip。

## 3. 多设备与执行所有权

### 3.1 固定规则

- Thread 可以被多个 Desktop/Web 客户端查看和输入，但一个活跃 Invocation 只有一个 `execution_ownership`。
- 打开、聚焦或恢复 Thread 不等于获得执行权，不触发环境迁移。
- Desktop 本地 WorkspaceBinding 与 device 绑定；另一设备不能只凭路径接管。
- 设备失联先进入恢复判断。能在同类型环境从 Checkpoint 恢复时创建 Attempt；不能恢复本地资源时等待原设备或用户显式变更方案。
- 活跃 Invocation 热迁移只有 Runtime capabilities 明确支持、无未核对副作用、Checkpoint 可用且新环境重新通过 Policy 时才允许；否则只影响下一 Invocation。
- 同一 `lease_epoch` 的 command/event 只能由当前 ownership 对应 Workload Identity 提交；旧设备迟到回调被拒绝。

业务例子：Desktop A 正在处理本地 Excel，员工在 Web 打开同一 Thread 并补充要求。Web 可以写 PendingInput，但不能把当前执行切到 Cloud。A 离线且没有可迁移文件 Checkpoint 时，系统显示等待设备，不伪装成云端继续。

### 3.2 请求变更执行环境

`POST /api/v1/threads/{thread_id}:request-execution-environment-change`

| 请求参数 | 位置 | 类型 | 必填 | 说明 |
|---|---|---|---:|---|
| thread_id | Path | string | 是 | 当前员工拥有的 Thread |
| Idempotency-Key | Header | string | 是 | 环境变更幂等键 |
| target_environment_definition_id | Body | string | 是 | 有权使用的目标环境定义 |
| target_device_id | Body | string/null | 否 | Desktop 目标设备；Cloud/Remote 不传 |
| apply_mode | Body | string | 是 | current_if_safe、next_invocation |
| reason_code | Body | string | 是 | DEVICE_OFFLINE、USER_SELECTED、RESOURCE_LOCATION_CHANGED |

```bash
curl -X POST 'https://snow.example.com/api/v1/threads/thr_01J...:request-execution-environment-change' \
  -H 'Authorization: Bearer <employee-token>' \
  -H 'Idempotency-Key: thr-01J-change-env-cloud' \
  -H 'Content-Type: application/json' \
  -d '{"target_environment_definition_id":"env_cloud_standard","target_device_id":null,"apply_mode":"current_if_safe","reason_code":"DEVICE_OFFLINE"}'
```

```json
{
  "request_id": "envchg_01J...",
  "thread_id": "thr_01J...",
  "invocation_id": "inv_01J...",
  "request_state": "accepted_for_next_invocation",
  "effective_mode": "next_invocation",
  "reason_code": "RUNTIME_HOT_MIGRATION_UNSUPPORTED",
  "event_id": "evt_environment_change_requested"
}
```

`current_if_safe` 是请求，不是承诺。当前 Runtime 不支持热迁移、存在 unknown_effect、目标环境无法访问 Attachment 或没有可用 Checkpoint 时，服务端降为 next_invocation 并返回明确原因；不能静默丢本地输入。

## 4. 制品供应链

### 4.1 发布门禁

AgentRevision、RuntimeRevision、Skill 可执行包、Tool Provider Adapter 和 Policy Bundle 的可执行制品必须使用内容 digest 标识。发布/路由前至少校验：

1. digest 与仓库制品一致，不使用可变 tag 作为历史依据。
2. 签名来自租户或平台允许的 builder identity。
3. provenance 记录源代码 revision、构建流水线、依赖锁文件和构建时间。
4. SBOM 可查询；命中阻断漏洞或禁止许可证时 verification_state 不是 verified。
5. Route 启动 Invocation 时再次确认引用 digest 与验证状态，结果写 ExecutionBinding config hash。
6. 动态 Tool/Skill 仍需信任等级和内容扫描；目录发现不等于可以执行未知代码。

签名、SBOM 和 provenance 可以存对象引用，但 digest、验证结论、验证策略修订和 builder identity 必须在 MySQL 可查询。撤销签名后阻止新 Invocation；已开始 Invocation 保留原绑定并由安全策略决定 cancel 或继续。

### 4.2 验证制品证明

`POST /admin/api/v1/artifact-attestations:verify`

| 请求参数 | 位置 | 类型 | 必填 | 说明 |
|---|---|---|---:|---|
| Idempotency-Key | Header | string | 是 | 验证请求幂等键 |
| artifact_type | Body | string | 是 | agent_revision、runtime_revision、skill_package、tool_provider、policy_bundle |
| artifact_revision_id | Body | string | 是 | 目标修订 id |
| artifact_digest | Body | string | 是 | `sha256:...` |
| signature_bundle_ref | Body | string | 是 | 受管对象引用，不接受任意公网 URL |
| sbom_ref | Body | string | 是 | 受管 SBOM 引用 |
| provenance_ref | Body | string | 是 | 受管 provenance 引用 |

```bash
curl -X POST 'https://snow.example.com/admin/api/v1/artifact-attestations:verify' \
  -H 'Authorization: Bearer <cicd-service-token>' \
  -H 'Idempotency-Key: verify-runtime-rev-7-sha256-ab' \
  -H 'Content-Type: application/json' \
  -d '{"artifact_type":"runtime_revision","artifact_revision_id":"rtr_7","artifact_digest":"sha256:ab...","signature_bundle_ref":"attestation:signature:901","sbom_ref":"attestation:sbom:901","provenance_ref":"attestation:provenance:901"}'
```

```json
{
  "attestation_id": "att_01J...",
  "artifact_revision_id": "rtr_7",
  "artifact_digest": "sha256:ab...",
  "verification_state": "verified",
  "builder_identity": "builder:company-agent-runtime",
  "policy_revision_id": "pol_supply_chain_12",
  "verified_at": "2026-07-15T01:50:00.000Z"
}
```

Service Identity 只能提交引用，不能自报 verification_state；验证服务独立读取签名、SBOM 和 provenance 后决定结果。失败也持久化安全摘要和 AuditEvent，响应不泄露内部漏洞细节给无权调用者。

## 5. 管理权限

### 5.1 Action scope

后台菜单只负责展示，服务端按稳定 `action_code + resource_scope` 判断。最低动作目录如下：

| Action code | 典型主体 | 资源 Scope | 是否审计 |
|---|---|---|---:|
| agent.revision.create | Agent 负责人 | agent/team | 是 |
| agent.publish | 发布负责人 | agent/environment | 是 |
| route.update | 发布负责人 | agent/environment | 是 |
| tool.schema.publish | Tool 负责人 | provider/tool | 是 |
| policy.publish | 安全管理员 | tenant/policy | 是 |
| credential.bind / credential.revoke | 连接管理员 | connection/principal | 是 |
| memory.review | 数据管理员 | workspace/agent/organization | 是 |
| job.cancel / job.retry | 任务运营 | job_type/owner | 是 |
| event.quarantine.resolve | 平台运维 | consumer/tenant | 是 |
| artifact.attestation.verify | CI Service Identity | artifact_type/project | 是 |
| legal_hold.manage | 合规管理员 | tenant/data_class | 是 |
| deletion.request | 数据主体或管理员 | self/tenant scope | 是 |
| audit.export | 审计员 | tenant/time range | 是 |

`principal_binding` 把外部 user/group/role/department 映射为平台主体；外部角色名不直接写进业务判断。资源 Scope 默认最小权限，空 allowlist 为全 deny。敏感动作可配置 SSO 强认证和双人复核，但是否启用由组织 Policy 决定。

业务例子：有 Agent 编辑权限的负责人可以创建 Revision，但没有 `agent.publish` 时不能发布；隐藏按钮不能替代后端 403。

## 6. Retention、Legal Hold 与删除

### 6.1 生命周期优先级

固定优先级：

```text
active Legal Hold
> 法规或组织最短保留
> 已受理删除请求
> 默认生命周期和容量清理
```

RetentionPolicy 按 `tenant + data_class + scope` 版本化，不在代码写死天数。删除规划器先做对象图解析：Thread Item/Event、Invocation、Trace、Artifact、Memory 来源、向量索引和审计各自判断，不使用数据库级无条件级联。共享 Knowledge、跨 Thread Memory、用户原始本地文件和被其他对象引用的 Artifact 不因单个 Thread 删除而清除。

### 6.2 创建 Legal Hold

`POST /admin/api/v1/legal-holds`

| 请求参数 | 位置 | 类型 | 必填 | 说明 |
|---|---|---|---:|---|
| Idempotency-Key | Header | string | 是 | Hold 创建幂等键 |
| hold_key | Body | string | 是 | 租户内稳定案件/调查键 |
| scope | Body | object | 是 | subject、thread、time_range、data_class 等类型化选择器 |
| reason_ref | Body | string | 是 | 受控案件引用，不写敏感案情全文 |
| effective_at | Body | string | 是 | RFC 3339 UTC |
| expires_at | Body | string/null | 否 | null 表示需显式释放 |

```bash
curl -X POST 'https://snow.example.com/admin/api/v1/legal-holds' \
  -H 'Authorization: Bearer <compliance-token>' \
  -H 'Idempotency-Key: hold-case-2026-017-v1' \
  -H 'Content-Type: application/json' \
  -d '{"hold_key":"case-2026-017","scope":{"subject_type":"user","subject_id":"usr_01J...","data_classes":["thread_content","trace"]},"reason_ref":"case-system:2026-017","effective_at":"2026-07-15T00:00:00.000Z","expires_at":null}'
```

```json
{
  "id": "hold_01J...",
  "hold_key": "case-2026-017",
  "hold_state": "active",
  "scope_hash": "sha256:19...",
  "created_by": "usr_compliance",
  "audit_event_id": "aud_01J..."
}
```

需要 `legal_hold.manage`。释放使用独立受控命令并写 released_by/released_at；不能 DELETE 行消除历史。

### 6.3 释放 Legal Hold

`POST /admin/api/v1/legal-holds/{legal_hold_id}:release`

| 请求参数 | 位置 | 类型 | 必填 | 说明 |
|---|---|---|---:|---|
| legal_hold_id | Path | string | 是 | active Hold id |
| Idempotency-Key | Header | string | 是 | 释放命令幂等键 |
| expected_scope_hash | Body | string | 是 | 防止释放对象已变化 |
| reason_ref | Body | string | 是 | 受控案件系统释放依据引用 |

```bash
curl -X POST 'https://snow.example.com/admin/api/v1/legal-holds/hold_01J...:release' \
  -H 'Authorization: Bearer <compliance-token>' \
  -H 'Idempotency-Key: release-hold-01J-v1' \
  -H 'Content-Type: application/json' \
  -d '{"expected_scope_hash":"sha256:19...","reason_ref":"case-system:2026-017:closed"}'
```

```json
{
  "id": "hold_01J...",
  "hold_state": "released",
  "released_by": "usr_compliance",
  "released_at": "2026-07-20T08:00:00.000Z",
  "audit_event_id": "aud_release_01J..."
}
```

需要 `legal_hold.manage`。释放不自动重启曾被阻止的删除请求；规划器按原 DeletionRequest 幂等重算 Scope 和当前策略，防止 Hold 期间资源关系变化。

### 6.4 创建员工删除请求

`POST /api/v1/deletion-requests`

| 请求参数 | 位置 | 类型 | 必填 | 说明 |
|---|---|---|---:|---|
| Idempotency-Key | Header | string | 是 | 删除请求幂等键 |
| subject_type | Body | string | 是 | thread、memory_entry、artifact、user_data_export_scope |
| subject_id | Body | string | 是 | 当前员工拥有或有权管理的对象 |
| delete_mode | Body | string | 是 | standard、privacy_request；不能绕过 Legal Hold |
| reason_code | Body | string | 是 | 固定为 USER_REQUESTED |

```bash
curl -X POST 'https://snow.example.com/api/v1/deletion-requests' \
  -H 'Authorization: Bearer <employee-token>' \
  -H 'Idempotency-Key: delete-thread-01J-v1' \
  -H 'Content-Type: application/json' \
  -d '{"subject_type":"thread","subject_id":"thr_01J...","delete_mode":"standard","reason_code":"USER_REQUESTED"}'
```

```json
{
  "id": "delreq_01J...",
  "request_state": "planning",
  "subject_type": "thread",
  "subject_id": "thr_01J...",
  "accepted_at": "2026-07-15T02:00:00.000Z",
  "progress_url": "/api/v1/deletion-requests/delreq_01J..."
}
```

受理时先阻止目标 Thread 新执行。响应不能提前写 completed；规划器解析所有存储和 Hold 后进入 deleting、blocked_by_hold 或 failed。

### 6.5 查询员工删除进度

`GET /api/v1/deletion-requests/{deletion_request_id}`

| 请求参数 | 位置 | 类型 | 必填 | 说明 |
|---|---|---|---:|---|
| deletion_request_id | Path | string | 是 | 删除请求 id |

```bash
curl 'https://snow.example.com/api/v1/deletion-requests/delreq_01J...' \
  -H 'Authorization: Bearer <employee-token>'
```

```json
{
  "id": "delreq_01J...",
  "request_state": "blocked_by_hold",
  "subject_type": "thread",
  "subject_id": "thr_01J...",
  "summary": {
    "planned_steps": 4,
    "completed_steps": 0,
    "blocked_resource_count": 3,
    "retained_shared_resource_count": 2
  },
  "blocked_reason_codes": ["ACTIVE_LEGAL_HOLD"],
  "details_visible": false,
  "updated_at": "2026-07-15T02:00:02.000Z"
}
```

普通员工只看到状态和计数，不看到 Hold 案件详情。completed 要求所有 in-scope DeletionStep 有存储端 evidence_ref；局部失败保持 failed/retryable，不伪装成全部完成。

### 6.6 创建管理员删除请求

`POST /admin/api/v1/deletion-requests`

| 请求参数 | 位置 | 类型 | 必填 | 说明 |
|---|---|---|---:|---|
| Idempotency-Key | Header | string | 是 | 管理删除幂等键 |
| subject_type | Body | string | 是 | thread、memory_entry、artifact、user、retention_scope |
| subject_id | Body | string | 是 | resource_scope 允许的对象 |
| delete_mode | Body | string | 是 | standard、privacy_request、retention_expiry |
| reason_code | Body | string | 是 | RETENTION_EXPIRED、ADMIN_POLICY、PRIVACY_REQUEST_VERIFIED |
| policy_revision_id | Body | string | 是 | 本次请求依据的不可变 Policy revision |

```bash
curl -X POST 'https://snow.example.com/admin/api/v1/deletion-requests' \
  -H 'Authorization: Bearer <data-admin-token>' \
  -H 'Idempotency-Key: retention-delete-trace-2026-07-15' \
  -H 'Content-Type: application/json' \
  -d '{"subject_type":"retention_scope","subject_id":"trace-before-2026-01-01","delete_mode":"retention_expiry","reason_code":"RETENTION_EXPIRED","policy_revision_id":"retpol_12"}'
```

```json
{
  "id": "delreq_admin_01J...",
  "request_state": "planning",
  "subject_type": "retention_scope",
  "subject_id": "trace-before-2026-01-01",
  "policy_revision_id": "retpol_12",
  "audit_event_id": "aud_01J...",
  "accepted_at": "2026-07-15T02:10:00.000Z"
}
```

需要 `deletion.request` action scope，且 resource_scope 必须覆盖 subject。Service Identity 执行定期保留清理时也走此接口，不能绕过 Legal Hold 直接批量 DELETE。

### 6.7 查询管理员删除进度

`GET /admin/api/v1/deletion-requests/{deletion_request_id}`

| 请求参数 | 位置 | 类型 | 必填 | 说明 |
|---|---|---|---:|---|
| deletion_request_id | Path | string | 是 | 管理员有权查看的删除请求 |
| include_steps | Query | boolean | 否 | true 时返回不含 Secret 的逐存储步骤 |

```bash
curl 'https://snow.example.com/admin/api/v1/deletion-requests/delreq_admin_01J...?include_steps=true' \
  -H 'Authorization: Bearer <data-admin-token>'
```

```json
{
  "id": "delreq_admin_01J...",
  "request_state": "deleting",
  "summary": {"planned_steps":4,"completed_steps":3,"failed_steps":0,"blocked_steps":0},
  "steps": [
    {"store_type":"mysql","step_state":"completed","evidence_ref":"deletion-evidence:mysql:701"},
    {"store_type":"object_storage","step_state":"running","evidence_ref":null}
  ],
  "updated_at": "2026-07-15T02:12:00.000Z"
}
```

响应不返回对象存储内部地址、删除凭证或 Hold 案件正文。只有全部 in-scope step completed 才能返回 request_state=completed。

## 7. 运维就绪与 SLO

### 7.1 查询系统就绪状态

`GET /admin/api/v1/operations/readiness`

| 请求参数 | 位置 | 类型 | 必填 | 说明 |
|---|---|---|---:|---|
| scope | Query | string | 否 | employee_api、runtime_dispatch、gateway、event_projection、job_scheduler、deletion；默认全部 |

```bash
curl 'https://snow.example.com/admin/api/v1/operations/readiness?scope=event_projection' \
  -H 'Authorization: Bearer <operations-token>'
```

```json
{
  "overall_state": "degraded",
  "checked_at": "2026-07-15T02:05:00.000Z",
  "components": [
    {
      "name": "event_projection",
      "state": "degraded",
      "reason_codes": ["QUARANTINED_STREAMS_PRESENT"],
      "metrics": {"max_lag_events":9,"quarantined_streams":1}
    }
  ]
}
```

Readiness 只返回结构化健康结果，不返回 Secret、内部拓扑或敏感 payload。它用于发布门禁和运维诊断，不作为业务状态事实源。

### 7.2 最低 SLO 和告警信号

具体目标值由组织与部署规模配置，但必须存在下列指标、预算和告警，不能只打日志：

| 能力 | SLI | 失败预算触发动作 |
|---|---|---|
| Employee 命令 | 接纳成功率、p95 接纳延迟、幂等冲突率 | 停止非必要发布，检查数据库与身份服务 |
| Event 续读 | 持久 Event 可读率、p95 推送延迟、cursor expired 比例 | 扩容推送、检查保留窗口与投影 lag |
| Runtime 调度 | queued 到 started 延迟、无可用 Runtime 比例 | 降低 Route 流量、扩容或回退 Revision |
| Gateway Tool | Schema 读取成功率、ToolCall 结果/unknown_effect 比例 | 隔离 Provider，停止自动重试副作用 |
| 投影 | 最大 lag、quarantined stream 数、checkpoint 停滞时间 | 告警并阻止依赖该投影的错误写操作 |
| Job | 取消确认延迟、replacement Job 创建成功率 | 检查调度器和领域校验服务 |
| 删除 | planning 延迟、步骤失败率、超期请求数 | 合规告警，不把 failed 改成 completed |
| 安全 | 未验证制品发布拦截、越权拒绝、Credential 泄露扫描命中 | 立即阻断并触发安全事件流程 |

## 8. 稳定错误码

| 错误码 | HTTP | 含义 |
|---|---:|---|
| EVENT_CURSOR_EXPIRED | 409 | 请求游标早于最早可用 sequence |
| EVENT_SEQUENCE_GAP | 409 | 消费流出现 sequence 空洞 |
| EVENT_SCHEMA_UNSUPPORTED | 422 | 消费者不支持该 schema_version |
| EVENT_QUARANTINE_RESOLUTION_NOT_ALLOWED | 422 | 事件不允许 skip 或理由不匹配 |
| STREAM_BACKPRESSURE | 429 | 连接或事件速率超过有界缓冲/配额 |
| EXECUTION_OWNERSHIP_CHANGED | 409 | 旧 lease epoch 的设备或 Runtime 回调 |
| ENVIRONMENT_CHANGE_NOT_SAFE | 422 | 当前执行不能安全热迁移 |
| ARTIFACT_ATTESTATION_FAILED | 422 | 签名、SBOM、provenance 或策略校验失败 |
| ARTIFACT_NOT_VERIFIED | 409 | 未验证制品不能发布或路由 |
| ACTION_SCOPE_DENIED | 403 | 主体没有所需 action_code/resource_scope |
| ACTIVE_LEGAL_HOLD | 409 | 物理删除被有效 Hold 阻止 |
| DELETION_STEP_FAILED | 503 | 某存储步骤失败，可按同一请求重试 |

## 9. 验收场景

| 场景 | 通过条件 |
|---|---|
| 投影遇到坏 Event | checkpoint 不越过；状态可查询；修复后按原 sequence 重放 |
| SSE 客户端长期阻塞 | 有界缓冲后断开；不拖垮 Event 写入；可按游标恢复 |
| Desktop 与 Web 同时打开 | Web 不抢 execution ownership；本地路径仍绑定原设备 |
| 设备离线且无文件 Checkpoint | 显示等待或显式变更，不声称 Cloud 已继续 |
| 未签名 RuntimeRevision 发布 | ARTIFACT_NOT_VERIFIED，Route 不变化，写 AuditEvent |
| 只有菜单权限 | 后端仍按 action_code/resource_scope 拒绝越权动作 |
| Thread 删除引用共享 Knowledge | Knowledge 不删除，DeletionStep 只覆盖 Thread 所有数据 |
| 删除命中 Legal Hold | request_state=blocked_by_hold；不执行匹配物理步骤 |
| 删除部分对象存储失败 | request_state=failed 或 deleting；有可重试步骤，不返回 completed |
