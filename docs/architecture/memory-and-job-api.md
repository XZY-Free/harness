# Memory 与 Job 写入边界

## 1. 边界结论

Runtime 可以提出记忆，但不能决定长期事实；Runtime 可以执行 Job 内 Invocation，但不能任意创建、复活或宣告整个 Job 完成。两个边界都采用“提案/命令 → 所属领域校验 → 持久事实”的结构。

~~~mermaid
flowchart LR
  Runtime["Runtime"] --> Candidate["MemoryCandidate"]
  Candidate --> Policy["Memory Policy"]
  Policy -->|accept| Entry["MemoryEntry"]
  Policy -->|review| Review["管理复核"]
  Policy -->|reject| Rejected["拒绝并按策略清理正文"]

  Domain["评测 / 知识 / 定时 / 批量领域"] --> Job["Job"]
  Admin["Admin Command"] --> Command["JobCommand"]
  Command --> Job
  Job --> Invocation["Invocation"]
~~~

公共身份、错误格式、幂等键和 Event 规则继承 [api-and-events.md](./api-and-events.md)。

业务例子：Agent 认为“用户默认中文”值得记住，只能提交 Candidate；Memory Policy 接受后才进入后续检索。管理员重跑失败的知识构建任务时，系统创建新 Job 并指向旧 Job，不覆盖旧事件。

## 2. Memory Candidate API

### 2.1 提交 Memory Candidate

`POST /gateway/v1/memory-candidates`

| 请求参数 | 位置 | 类型 | 必填 | 说明 |
|---|---|---|---:|---|
| Idempotency-Key | Header | string | 是 | Invocation 内候选幂等键 |
| invocation_id | Body | string | 是 | Workload Identity 绑定的 Invocation |
| source | Body | object | 是 | type 为 thread_item、job_result、artifact；id/hash 必须属于当前 Invocation 可访问来源 |
| proposed_scope | Body | object | 是 | type 为 thread、workspace、user_preference、agent、organization；ref 由服务端复核 |
| memory_type | Body | string | 是 | preference、fact、instruction、decision、summary |
| content | Body | object | 是 | `text` 或受控 `content_ref`，最大尺寸由 Policy 配置 |
| content_hash | Body | string | 是 | 规范化候选内容 hash |
| sensitivity_hint | Body | string | 否 | Runtime 提示，不替代平台扫描 |
| expires_at | Body | string/null | 否 | RFC 3339 UTC；平台可缩短，不可越过 Scope 策略 |
| rationale_code | Body | string | 是 | USER_EXPLICIT、REPEATED_PREFERENCE、PROJECT_FACT、TASK_DECISION |

```bash
curl -X POST 'https://snow.example.com/gateway/v1/memory-candidates' \
  -H 'Authorization: Bearer <invocation-workload-token>' \
  -H 'Idempotency-Key: inv-42-memory-language-preference' \
  -H 'Content-Type: application/json' \
  -d '{"invocation_id":"inv_01J...","source":{"type":"thread_item","id":"item_user_7","hash":"sha256:40..."},"proposed_scope":{"type":"user_preference","ref":"current-user"},"memory_type":"preference","content":{"text":"默认使用简体中文回答"},"content_hash":"sha256:41...","sensitivity_hint":"none","expires_at":null,"rationale_code":"USER_EXPLICIT"}'
```

```json
{
  "candidate_id": "memc_01J...",
  "candidate_state": "accepted",
  "decision_reason_codes": ["USER_EXPLICIT","LOW_SENSITIVITY","SCOPE_ALLOWED"],
  "resolved_memory_entry_id": "mem_01J...",
  "effective_scope": {"type":"user_preference","ref":"usr_current"},
  "index_state": "queued",
  "resolved_at": "2026-07-15T01:30:00.000Z"
}
```

可能结果为 accepted、rejected 或 needs_review。接受与 MemoryEntry upsert 在同一事务完成；向量索引异步，不影响 accepted 事实。相同内容和 Scope 命中现有 Entry 时返回该 id 并更新来源关系，不创建重复事实。Thread Invocation 可引用 thread_item/Artifact，Job Invocation 可引用 job_result/Artifact；两者都不能伪造不属于自己的 source。Organization Scope 永不由 Runtime 自动接受。Secret、验证码、Token、Cookie、私钥或 Credential 指纹命中安全规则时直接 rejected，响应不回显敏感正文。

### 2.2 查询 Memory Candidate

`GET /gateway/v1/memory-candidates/{candidate_id}`

| 请求参数 | 位置 | 类型 | 必填 | 说明 |
|---|---|---|---:|---|
| candidate_id | Path | string | 是 | Candidate id |
| invocation_id | Query | string | 是 | 原提交 Invocation；Workload Identity 必须一致 |

```bash
curl 'https://snow.example.com/gateway/v1/memory-candidates/memc_01J...?invocation_id=inv_01J...' \
  -H 'Authorization: Bearer <invocation-workload-token>'
```

```json
{
  "candidate_id": "memc_01J...",
  "candidate_state": "needs_review",
  "decision_reason_codes": ["ORGANIZATION_SCOPE_REQUIRES_REVIEW"],
  "resolved_memory_entry_id": null,
  "submitted_at": "2026-07-15T01:30:00.000Z",
  "resolved_at": null
}
```

Runtime 只能查看自己 Invocation 提交的 Candidate，且响应只返回脱敏决定。等待人工复核不暂停普通 Invocation；业务确实要求该记忆先获批时，应使用独立 UserAction/业务流程，而不是轮询占用执行资源。

### 2.3 复核 Memory Candidate

`POST /admin/api/v1/memory-candidates/{candidate_id}:resolve`

| 请求参数 | 位置 | 类型 | 必填 | 说明 |
|---|---|---|---:|---|
| candidate_id | Path | string | 是 | needs_review Candidate |
| Idempotency-Key | Header | string | 是 | 复核幂等键 |
| resolution | Body | string | 是 | accept、reject |
| effective_scope | Body | object | 否 | accept 时可缩小 Scope，不能扩大原提案 |
| expires_at | Body | string/null | 否 | accept 时按策略设置 |
| reason_code | Body | string | 是 | 稳定复核原因码 |

```bash
curl -X POST 'https://snow.example.com/admin/api/v1/memory-candidates/memc_01J...:resolve' \
  -H 'Authorization: Bearer <admin-token>' \
  -H 'Idempotency-Key: review-memc-01J-v1' \
  -H 'Content-Type: application/json' \
  -d '{"resolution":"accept","effective_scope":{"type":"workspace","ref":"ws_sales"},"expires_at":"2027-01-01T00:00:00.000Z","reason_code":"VERIFIED_PROJECT_FACT"}'
```

```json
{
  "candidate_id": "memc_01J...",
  "candidate_state": "accepted",
  "resolved_memory_entry_id": "mem_01J...",
  "effective_scope": {"type":"workspace","ref":"ws_sales"},
  "resolved_by": "usr_admin",
  "audit_event_id": "aud_01J..."
}
```

需要 `memory.review` action scope。已解析 Candidate 重放返回原结果；不同 resolution 返回 `MEMORY_CANDIDATE_ALREADY_RESOLVED`。管理员只能缩小到自己有权管理的 Scope。

## 3. Context Checkpoint API

Checkpoint 用于恢复上下文组装位置，不保存每次模型调用的全量上下文包。

### 3.1 提交 Context Checkpoint

`POST /gateway/v1/context-checkpoints`

| 请求参数 | 位置 | 类型 | 必填 | 说明 |
|---|---|---|---:|---|
| Idempotency-Key | Header | string | 是 | checkpoint 幂等键 |
| invocation_id | Body | string | 是 | 当前 Invocation |
| checkpoint_type | Body | string | 是 | assembly、compression、resume |
| source_ranges | Body | object[] | 是 | Thread Item/Event、Memory、Knowledge 的 id 与 hash 范围 |
| summary | Body | object | 是 | 脱敏摘要或 content_ref，不含隐藏思维链 |
| summary_hash | Body | string | 是 | 摘要 hash |
| token_accounting | Body | object | 是 | 输入、保留、压缩 Token 数 |

```bash
curl -X POST 'https://snow.example.com/gateway/v1/context-checkpoints' \
  -H 'Authorization: Bearer <invocation-workload-token>' \
  -H 'Idempotency-Key: inv-42-compression-2' \
  -H 'Content-Type: application/json' \
  -d '{"invocation_id":"inv_01J...","checkpoint_type":"compression","source_ranges":[{"type":"thread_item","from_sequence":1,"to_sequence":42,"range_hash":"sha256:77..."}],"summary":{"text":"用户要求分析销售异常，已确认口径……"},"summary_hash":"sha256:88...","token_accounting":{"input":32000,"retained":7200,"compressed":24800}}'
```

```json
{
  "checkpoint_id": "ctxcp_01J...",
  "invocation_id": "inv_01J...",
  "checkpoint_type": "compression",
  "summary_hash": "sha256:88...",
  "created_at": "2026-07-15T01:35:00.000Z"
}
```

平台校验来源属于当前可访问 Scope 且 hash 匹配。Checkpoint 不删除原始 Item/Event，不写 Memory，不保存 Credential 或隐藏思维链；Runtime 恢复时必须重新校验引用仍可访问。

## 4. Job Control API

Job 的创建属于具体领域接口：评测接口创建 evaluation Job、知识接口创建 knowledge_build Job、调度接口创建 scheduled Job。不提供 Runtime 可调用的 `POST /jobs` 万能入口。

### 4.1 查询 Job

`GET /admin/api/v1/jobs/{job_id}`

| 请求参数 | 位置 | 类型 | 必填 | 说明 |
|---|---|---|---:|---|
| job_id | Path | string | 是 | Job id |
| include | Query | string[] | 否 | invocations、commands、result_summary；默认只返回摘要 |

```bash
curl 'https://snow.example.com/admin/api/v1/jobs/job_01J...?include=invocations&include=commands' \
  -H 'Authorization: Bearer <admin-token>'
```

```json
{
  "id": "job_01J...",
  "job_type": "knowledge_build",
  "job_state": "running",
  "replaces_job_id": null,
  "progress": {"completed":72,"total":100,"unit":"documents"},
  "invocations": [{"id":"inv_job_1","execution_state":"running"}],
  "commands": [],
  "latest_event_sequence": 48,
  "etag": "\"job-12\""
}
```

调用者需要该 Job 类型的查看权限。结果摘要不返回原始文档、Credential 或跨租户对象存在性；详细 Trace 仍走受控观测接口。

### 4.2 请求取消 Job

`POST /admin/api/v1/jobs/{job_id}:cancel`

| 请求参数 | 位置 | 类型 | 必填 | 说明 |
|---|---|---|---:|---|
| job_id | Path | string | 是 | running、queued 或 waiting_external Job |
| Idempotency-Key | Header | string | 是 | 取消命令幂等键 |
| If-Match | Header | string | 是 | 当前 Job ETag |
| reason_code | Body | string | 是 | USER_REQUESTED、POLICY_REVOKED、UPSTREAM_CANCELLED、BUDGET_EXHAUSTED |
| comment | Body | string | 否 | 脱敏说明，最大 500 字符 |

```bash
curl -X POST 'https://snow.example.com/admin/api/v1/jobs/job_01J...:cancel' \
  -H 'Authorization: Bearer <admin-token>' \
  -H 'Idempotency-Key: cancel-job-01J-v1' \
  -H 'If-Match: "job-12"' \
  -H 'Content-Type: application/json' \
  -d '{"reason_code":"USER_REQUESTED","comment":"数据源范围配置错误"}'
```

```json
{
  "job_id": "job_01J...",
  "job_state": "running",
  "command_id": "jobcmd_01J...",
  "command_state": "queued",
  "event_id": "jobevt_cancel_requested",
  "requested_at": "2026-07-15T01:40:00.000Z"
}
```

返回 202。Job 仍为 running，直到调度器处理所有 Invocation 并核对副作用后才进入 cancelled。已 completed/failed 的 Job 返回 `JOB_ALREADY_TERMINAL`；已经 cancelled 的相同命令重放返回原结果。需要 `job.cancel` action scope。

### 4.3 重新运行终态 Job

`POST /admin/api/v1/jobs/{job_id}:retry`

| 请求参数 | 位置 | 类型 | 必填 | 说明 |
|---|---|---|---:|---|
| job_id | Path | string | 是 | completed、failed 或 cancelled 的原 Job |
| Idempotency-Key | Header | string | 是 | retry 幂等键 |
| reuse_input | Body | boolean | 是 | true 时仍由所属领域重新验证输入引用、权限和保留状态 |
| override | Body | object | 否 | 仅允许该 Job 类型声明的安全覆盖字段 |
| reason_code | Body | string | 是 | TRANSIENT_FAILURE_FIXED、INPUT_CORRECTED、ADMIN_RERUN |

```bash
curl -X POST 'https://snow.example.com/admin/api/v1/jobs/job_old:retry' \
  -H 'Authorization: Bearer <admin-token>' \
  -H 'Idempotency-Key: retry-job-old-v1' \
  -H 'Content-Type: application/json' \
  -d '{"reuse_input":true,"override":{"max_concurrency":4},"reason_code":"TRANSIENT_FAILURE_FIXED"}'
```

```json
{
  "source_job_id": "job_old",
  "replacement_job": {
    "id": "job_new",
    "job_type": "knowledge_build",
    "job_state": "queued",
    "replaces_job_id": "job_old",
    "latest_event_sequence": 1
  },
  "command_id": "jobcmd_retry_01J...",
  "audit_event_id": "aud_01J..."
}
```

需要 `job.retry` action scope。新 Job 使用当前有效 Policy、Route 和可访问输入；不会复制旧 ExecutionBinding，也不会把旧 Job 从终态改回 queued。包含 unknown_effect 的原 Job 必须先完成核对，或由所属领域明确声明新 Job 不会重复该副作用。

### 4.4 订阅 JobEvent 与发布结果

JobEvent 订阅和结果投影沿用 [api-and-events.md](./api-and-events.md)：

- `GET /admin/api/v1/jobs/{job_id}/events` 使用 Job 内 sequence 续读。
- `POST /admin/api/v1/jobs/{job_id}:publish-to-thread` 只允许发布到 Job 创建时预先关联的 Thread。
- Job cancel/retry 命令事件进入 JobEvent，不进入员工 Thread；只有显式 job_result projection 才进入 ThreadEvent。

## 5. 稳定错误码

| 错误码 | HTTP | 含义 |
|---|---:|---|
| MEMORY_SOURCE_NOT_ALLOWED | 403 | source Item 不属于当前 Invocation 可访问范围 |
| MEMORY_SCOPE_NOT_ALLOWED | 403 | 提议或复核 Scope 越权 |
| MEMORY_SENSITIVE_CONTENT | 422 | 候选命中禁止进入 Memory 的敏感内容 |
| MEMORY_CANDIDATE_ALREADY_RESOLVED | 409 | 已解析 Candidate 收到不同决定 |
| MEMORY_CONTENT_HASH_MISMATCH | 409 | 提交正文与 hash 不一致 |
| CONTEXT_SOURCE_HASH_MISMATCH | 409 | Checkpoint 来源范围已变化或 hash 不一致 |
| CONTEXT_CHECKPOINT_TOO_LARGE | 413 | 摘要或来源清单超过限制 |
| JOB_ALREADY_TERMINAL | 409 | 对终态 Job 请求 cancel |
| JOB_NOT_TERMINAL | 409 | 对非终态 Job 请求 retry |
| JOB_INPUT_NO_LONGER_AVAILABLE | 422 | 原输入已删除、过期或无权访问 |
| JOB_RETRY_BLOCKED_BY_UNKNOWN_EFFECT | 409 | 未核对副作用前不能重跑 |
| JOB_OVERRIDE_NOT_ALLOWED | 422 | override 含该 Job 类型未声明字段 |

## 6. 验收场景

| 场景 | 通过条件 |
|---|---|
| Runtime 直接写 MemoryEntry | 无此接口；数据库账号也无写权限 |
| 相同 Candidate 重放 | 返回同一 candidate/memory entry，不重复建索引事实 |
| Candidate 含 Token | rejected；响应、Event、Trace 不回显原值 |
| Organization Memory | 必须 needs_review，并由具有 memory.review 的管理员处理 |
| Context 压缩 | 原始 Item/Event 保留；Checkpoint 只有来源范围、摘要和 hash |
| 取消 running Job | 先写 cancel_requested；调度器确认后才 cancelled |
| 重跑 failed Job | 新 Job 指向原 Job；旧 Job 状态、Event 和结果不变 |
| Runtime 试图创建任意 Job | 无通用创建入口；只有所属领域服务可创建 |
