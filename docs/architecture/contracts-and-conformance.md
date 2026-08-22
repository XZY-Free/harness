# 机器契约与一致性门禁

## 1. 交付物

的自然语言文档用于解释业务语义，机器契约用于生成客户端、校验 Adapter 和阻止协议漂移。两者同时属于规范：API 参数表和响应示例是 OpenAPI 的生成输入；Event、错误码和一致性用例以 `contracts/` 中的 JSON 为机器事实源。

| 文件 | 用途 | 维护方式 |
|---|---|---|
| [openapi.json](./contracts/openapi.json) | 63 个 Employee、Runtime、Gateway、Admin/Operations 操作的 OpenAPI 3.1 契约 | 由 11—14 号接口文档生成，禁止手改 |
| [event-envelope.schema.json](./contracts/event-envelope.schema.json) | ThreadEvent/JobEvent 公共 Envelope JSON Schema | 手工评审，提升 schema_version 后演进 |
| [event-catalog.json](./contracts/event-catalog.json) | 91 个持久 Event 类型、可用流、必需引用和是否允许投影跳过 | 手工评审；状态语义变化必须联动领域模型 |
| [error-codes.json](./contracts/error-codes.json) | 49 个稳定错误码、HTTP 映射和 retryable 语义 | 所有接口共用；OpenAPI operation 显式列出可返回 code，删除或改变重试语义视为破坏性变化 |
| [runtime-conformance.json](./contracts/runtime-conformance.json) | 外部 Runtime Adapter 必过的一致性场景 | Hosted 与 External Runtime 使用同一组语义测试 |
| [contract-manifest.json](./contracts/contract-manifest.json) | 契约版本、文件清单和兼容性级别 | 契约发布入口 |

业务例子：Adapter 声称支持 steer 之前，必须通过“queued 后等待 Runtime safe-point ack 才产生 steered”的一致性用例；仅能接收 HTTP 请求但提前伪造 ack 的 Adapter 不能标记该能力为 true。

## 2. OpenAPI 生成规则

[generate_openapi.py](./scripts/generate_openapi.py) 扫描 11—14 号文档中的接口章节：

```text
### 接口名
`METHOD /path`
请求参数表
curl 示例
JSON 响应示例
```

生成器把参数位置、类型、必填项、响应示例、身份边界和文档定位写入 OpenAPI。接口文档若缺少这个顺序，就不会形成有效机器契约。Runtime Endpoint 上由平台调用外部 Runtime 的操作在 operation 级声明独立 server；Runtime 回传平台的入口仍使用 SnowHarness server。

生成文件中的响应 Schema 由规范示例推导，因此示例必须包含该接口稳定返回的全部必需字段。可选字段应在参数表和正文说明，并在实现 Schema 中显式标为可选；不能依赖客户端猜测自然语言。

执行命令：

```bash
python3 docs/contracts/scripts/generate_openapi.py --write
python3 docs/contracts/scripts/generate_openapi.py --check
```

生成和校验不访问网络，不依赖生产服务，不包含真实 Token、地址或用户数据。

## 3. Event 兼容性

### 3.1 Envelope 与 payload

Envelope 的 `event_id`、`stream_type`、`sequence`、`event_type`、`schema_version`、`actor`、`occurred_at` 和 `payload` 是必需字段。Thread 和 Job 恰有一个 stream id：

```json
{
  "event_id": "evt_01J...",
  "stream_type": "thread",
  "sequence": 52,
  "event_type": "item.completed",
  "schema_version": 1,
  "thread_id": "thr_01J...",
  "turn_id": "turn_01J...",
  "item_id": "item_01J...",
  "invocation_id": "inv_01J...",
  "actor": {"type":"agent","id":"agt_finance"},
  "correlation_id": "corr_01J...",
  "causation_id": "evt_previous",
  "idempotency_key": null,
  "occurred_at": "2026-07-15T01:02:03.456Z",
  "payload": {"item_type":"agent_message","content_hash":"sha256:..."}
}
```

兼容规则：

- 新增 Event type 是加法变化；旧消费者忽略未知类型前，仍要按策略记录消费结果，不能无痕前移。
- payload 新增可选字段兼容；新增必填、删除、重命名或改变类型必须提升该 Event 的 `schema_version`。
- 改变 Event 对状态机的含义不是 payload 小改，必须提升 API major 或增加新 Event type。
- `event-catalog.json` 标为不可跳过的 Event 发生映射失败时，checkpoint 必须停止。
- Runtime 原始回调名不进入 catalog；Adapter 先映射为规范 Event candidate。

### 3.2 Schema 支持声明

Runtime capabilities 响应必须列出可生产的 candidate event type 和最大 schema version。平台派发前校验必需集合是 Adapter 支持集合的子集；运行中提交未声明类型返回 `EVENT_SCHEMA_UNSUPPORTED`。消费者部署新版本时先支持新旧 schema，再允许生产者切换，最后按保留窗口移除旧读逻辑。

## 4. 错误协议

所有错误响应中的 `error.code` 必须存在于 `error-codes.json`。`retryable=true` 只表示相同语义请求在前置条件变化后可以重试，不等于客户端立即无限重放：

- `TOOL_SCHEMA_CHANGED`：重新读取 Schema 并重新生成参数后重试。
- `EVENT_CURSOR_EXPIRED`：不能重试原 SSE 游标，先取快照。
- `STREAM_BACKPRESSURE`：等待 `retry_after_ms` 后按最后持久 sequence 重连。
- `unknown_effect` 不是普通 retryable 错误；必须先核对 Effect。
- 403/404 越权类错误不得通过枚举 id 重试探测资源。

错误 message 可以本地化，客户端分支只依赖 code、HTTP、retryable 和声明的 details 字段。

## 5. Runtime Adapter 一致性门禁

每个 RuntimeRevision 在可路由前提交 capability probe，并对 `runtime-conformance.json` 的 required cases 产生可追踪结果。最少覆盖：

1. ExecutionBinding 不可变。
2. candidate event 批次幂等、hash 冲突和 Attempt sequence 连续。
3. steer/cancel/resume 的命令 ack 语义。
4. Tool Schema 刷新与 unknown_effect 禁止盲重放。
5. 能力搜索不等于 CapabilityUse。
6. Memory 只能提案。
7. Child Thread 独立状态、预算、权限和结果投影。
8. Credential 原值不进入模型和持久协议。
9. execution ownership epoch 拒绝旧设备迟到回调。
10. Session 恢复不冒充文件系统恢复。

结果记录 RuntimeRevision、Adapter digest、测试环境、case id、结果、证据 ref 和时间。失败 case 对应 capability 必须设为 false；身份、事件幂等、取消、Credential 隔离等基础 case 失败时整个 RuntimeRevision 不得进入 DeploymentRoute。

业务例子：某外部 Runtime 不支持 steer，但其他基础 case 通过，可以发布并声明 `steer=false`，员工端禁用“引导”；若它无法保证 event idempotency，则不能发布，因为这会重复创建 Item 或副作用。

## 6. 校验脚本

[validate_contracts.py](./scripts/validate_contracts.py) 执行以下检查：

- OpenAPI 与接口文档是否同步，path 和 operationId 是否唯一。
- 每个操作是否有身份边界、成功响应、统一错误响应和文档定位。
- Event Envelope 必需字段、Event 名称、stream/ref 和不可跳过终态。
- 文档错误码是否全部进入机器目录，HTTP 映射是否一致。
- Runtime 一致性 case 是否完整且 id 唯一。
- 统一领域/数据模型中是否存在 MemoryCandidate、replacement Job、投影 checkpoint、Legal Hold、执行所有权和制品证明。
- 主导 Agent Handoff 是否统一使用 UserActionRequest，而不是形成第二套交接请求事实（交接语义属后续 Agent 调用专题）。

```bash
python3 docs/contracts/scripts/validate_contracts.py
```

该命令应进入 文档和 Adapter 变更的 CI；失败时禁止合并契约变更。它验证协议一致性，不冒充真实 Runtime、MySQL、对象存储和 Tool 集成测试。

## 7. 实现切分

机器契约允许服务并行实施，但写入顺序不能打乱：

| 实现单元 | 先依赖 | 可独立验证 |
|---|---|---|
| Employee API | Thread/Turn/Item/Event Application Service | 幂等创建、ETag、SSE 游标 |
| Runtime Dispatcher/Ingress | Invocation、ExecutionBinding、Ingress ledger | 重放、hash 冲突、命令 ack |
| Gateway | Capability、Policy、Credential、ToolCall | Schema 变化、权限、Effect |
| Child Thread | ThreadRelation + 父子命令协调器 | 上下文隔离、预算、结果投影 |
| Memory Policy | MemoryCandidate + MemoryEntry | Scope、敏感拒绝、去重与复核 |
| Job Control | JobCommand + 所属领域服务 | cancel 请求/确认、replacement Job |
| Projection Delivery | Checkpoint + Failure + Stream floor | 顺序、隔离、重放和 cursor expired |
| Data Lifecycle | RetentionPolicy + LegalHold + DeletionStep | 资源图、Hold 阻断、逐存储证明 |

实现不能先让 Runtime 直写数据库再补 API，也不能让前端先依赖未进入契约的临时字段。任何临时扩展使用 `x-` 调试字段且不得写入持久 Event；进入产品前必须完成正式契约评审。
