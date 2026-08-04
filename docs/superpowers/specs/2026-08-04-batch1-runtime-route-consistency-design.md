# 第一批：Runtime 发布资格闭环与 RouteSet 聚合一致性

> 依据：`docs/V12/01/SnowHarness 01专题后续四批整改总方案.docx` 第四～七节
> 基线：main @ 6a1283c

## 一、目标

本批解决两个真实问题：

1. **Runtime 发布资格不闭环**：当前允许 `attestationIds = []` 的 PublicationRecord，导致 Runtime 可处于 `published` 但无路由资格。
2. **Route 配置错误只能在执行时发现**：当前 Route 激活是单条操作，控制面可以成功保存错误配置直到用户创建 Invocation 时才失败。

## 二、全局规则

- 每个任务独立分支、独立提交、独立测试、完成后停止
- 正式对象按职责命名，禁止 V12/New/Next/ControlPlaneV2 命名
- 数据库：新建 Migration，不修改历史 Migration；先增加、后迁移、再收紧
- 实现模型不得自行决定领域语义（Published 含义、Attestation 是否必填、Route 冲突裁决等）

## 三、任务 1.1 — 收紧 Runtime 发布合同

### 修改文件
- `lib/runtimes/application/publish-runtime-revision.ts`
- `lib/runtimes/persistence/runtime-publication-store.ts`
- `lib/runtimes/persistence/mysql-runtime-publication-store.ts`
- `lib/runtimes/domain/runtime-revision-publication-policy.ts`
- `lib/runtimes/application/publish-runtime-revision-service.ts`
- `lib/runtimes/domain/runtime-conformance-contract.ts`（新增）

### 变更

#### 3.1 Conformance 合同唯一入口

新增 `lib/runtimes/domain/runtime-conformance-contract.ts`：

```typescript
export type ConformanceCaseId = /* 16个 case 的 union type */;
export const ALL_CONFORMANCE_CASES: ConformanceCaseId[];
export const MANDATORY_GATE_CASES = ALL_CONFORMANCE_CASES;
export const CONFORMANCE_SUITE_REVISION: string;
export function validateCompleteConformanceResult(
  results: StoredRuntimeConformanceResult[],
  revision: RuntimePublicationRevision,
): void;
```

所有消费者（PublicationPolicy、ConformanceRun、MySQL Store、Runner、测试）引用此唯一合同，不硬编码 "16"。

#### 3.2 Command 类型

```diff
- attestationId?: string
- conformanceRunId?: string
+ attestationId: string
+ conformanceRunId: string
```

#### 3.3 Attestation 证据快照 + 统一 Policy

Store Port 返回完整快照，不在应用服务中复制判断：

```typescript
interface RuntimePublicationEvidenceSnapshot {
  id: string;
  tenantId: string;
  artifactType: string;
  artifactRevisionId: string;
  artifactId: string;
  artifactDigest: string;
  verificationState: string;
  revokedAt: Date | null;
  revocationRecordId: string | null;
}
```

新增 `ArtifactEvidencePolicy.validateForRuntimePublication(snapshot, revision)`：统一验证类型、租户、绑定、Digest、撤销。

#### 3.4 新增错误类型

- `RuntimeArtifactAttestationRequiredError` — 缺少 Attestation
- `RuntimeArtifactAttestationInvalidError` — Attestation 绑定/撤销/验证无效
- `RuntimeConformanceRunRequiredError` — 缺少 ConformanceRun
- `RuntimeConformanceRunInvalidError` — Run 绑定/Case 不完整/Digest 不一致
- `RuntimePublicationVersionConflictError` — 保留

#### 3.5 发布执行顺序（20步）

1. 校验 actor.tenantId 与 command.tenantId 一致
2. 校验 attestationId 和 conformanceRunId 非空
3. 开启数据库事务
4. FOR UPDATE 读取 RuntimeRevision
5. 校验 Revision 状态为 draft
6. FOR UPDATE 读取 Runtime
7. 校验 Runtime.versionNo 等于 expectedVersionNo
8. FOR UPDATE 读取 Attestation 证据快照
9. ArtifactEvidencePolicy.validateForRuntimePublication 校验完整绑定
10. FOR UPDATE 读取 ConformanceRun
11. 校验 Run 与 Revision 的 Artifact Digest 一致
12. 校验 Run 与 Revision 的 Config Digest 一致
13. 校验 Run 与 Revision 的 Protocol Contract Revision 一致
14. validateCompleteConformanceResult 校验 16 Case 完整且全部 passed
15. 创建 PublicationRecord，attestationIds 必须非空
16. CAS 更新 RuntimeRevision 为 published
17. CAS 更新 Runtime.currentRevisionId 和 versionNo
18. 写 Audit + Outbox + Idempotency
19. 提交事务
20. 任一步失败整体回滚

## 四、任务 1.2 — 修改 Runtime 发布 API

### 修改文件
- `app/admin/api/v1/runtime-revisions/[revision_id]/conformance/route.ts`
- `lib/control-plane/admin-routes.test.ts`
- `e2e/admin-conformance.spec.ts`

### 变更

#### 4.1 请求体

`publish=false`：不变（runner_report + runner_signature）

`publish=true` 新增必填：
- `artifact_attestation_id: string`
- `expected_version_no: number`（已有，确认必填）
- `Idempotency-Key` header（已有）
- `If-Match` header（已有）

#### 4.2 传递 attestationId

`publishRuntimeRevisionThroughControlPlane` 调用增加 `attestationId` 参数。

#### 4.3 错误映射

```
缺少 artifact_attestation_id              → 400 REQUEST_SCHEMA_INVALID
Attestation 不存在或已撤销                 → 409 ARTIFACT_NOT_VERIFIED
                                           或 ARTIFACT_ATTESTATION_REVOKED
Attestation 绑定/Digest 不匹配             → 409 ARTIFACT_BINDING_MISMATCH
Conformance 绑定不一致                     → 422 BUSINESS_CONSTRAINT_VIOLATION
Runtime 乐观锁冲突                         → 412 ETAG_MISMATCH
```

#### 4.4 幂等行为

同一 Idempotency-Key + 相同请求体：返回首次成功响应。
同一 Idempotency-Key + 不同请求体：409 IDEMPOTENCY_CONFLICT。

## 五、任务 1.3 — RouteSet 聚合领域模型

### 新增文件
- `lib/routes/domain/route-set-activation-policy.ts`
- `lib/routes/domain/route-selector.ts`

### RouteSelector（纯计算，不访问数据库）

```typescript
normalizeEligibility(conditions: unknown): NormalizedEligibility
computeSpecificity(normalized: NormalizedEligibility): number
computeSelectorDigest(normalized: NormalizedEligibility): string  // 含算法版本 "route-selector/v1"
isOverlapping(left: NormalizedEligibility, right: NormalizedEligibility): boolean
```

### RouteSetActivationPolicy

输入：`{ routeSetId, routeScopeKey, desiredActiveRoutes[] }`

每个 DesiredRoute 至少包含：
- routeId, routeRevisionId, routeGroupId, trafficWeight, priorityNo
- eligibilityConditions, effectiveFrom, effectiveUntil, activationState

输出：`{ valid, normalizedGroups, validationErrors }`

### 聚合不变量

- Weight 1–10000；Disabled 不参与合计
- 同组成员必须完全相同：eligibilityConditions, priorityNo, specificity, effectiveFrom, effectiveUntil
- 每个 Active Group 权重合计 = 10000
- 同 priorityNo + 同 specificity + eligibility 重叠 + 有效时间窗口重叠 → 不同 Group 禁止共存
- Route / RouteRevision 不重复
- 生效时间合法；同 RouteSet + 同 Tenant + 同 Agent
- 权重 10000 必须在 Group 完整有效窗口内持续成立

## 六、任务 1.4 — 数据库支持 Route Group

### Migration 0117

RouteRevision 新增 nullable 列：
- `routeGroupId varchar(128) NULL`
- `selectorDigest varchar(71) NULL`

RouteActivation 新增 nullable 列：
- `routeSetId varchar(36) NULL`

部署兼容代码（读写均处理 NULL）。

### 幂等 Backfill 命令

使用正式 RouteSelector 算法回填。规则：
- `trafficAllocationJson.groupId` 存在 → 使用原值
- 单条 10000 权重 Route → `primary`
- 多条 Route 无 Group ID → 由 selectorDigest + priorityNo + effectiveWindow 生成确定性 legacy group ID
- 无法组成 10000 权重的集合 → 标记 `legacy_route_set_invalid`，留给后续 Cutover

重复执行结果一致。输出无法安全归组的历史 RouteSet。

### Migration 0118

验证零 NULL → 增加 NOT NULL → 增加最终索引：

- `RouteRevision(routeSetId, routeGroupId, priorityNo)`
- `RouteRevision(routeSetId, selectorDigest, priorityNo)`
- `RouteActivation(routeSetId, routeSetVersionNo)`

保留 `trafficAllocationJson`、V11 投影字段。

RouteActivation.routeSetId 始终 = 对应 RouteRevision.routeSetId（派生冗余列，写入服务负责派生和断言）。

## 七、任务 1.5 — RouteSet 整体激活服务

### 新增文件
- `lib/routes/application/activate-route-set.ts`
- `lib/routes/persistence/route-set-activation-store.ts`
- `lib/routes/persistence/mysql-route-set-activation-store.ts`

### ActivateRouteSetCommand

```typescript
{
  tenantId: string;
  routeSetId: string;
  expectedVersionNo: number;
  desiredRoutes: DesiredRoute[];
  actor: AuditActor;
  reason: string;
  requestId: string;
  idempotencyKey: string;
  idempotencyCompletion?: IdempotencyCompletion;
}
```

desiredRoutes 表示目标 RouteSet 的完整 Active 状态（非增量 Patch）。

### 事务流程（22步）

1. 开启事务
2. FOR UPDATE 锁定 RouteSet
3. 校验 expectedVersionNo
4. 读取当前所有 Route 和 Active RouteRevision
5. 将命令转换为完整目标集合
6. 校验所有 AgentRevision 和 RuntimeRevision
7. 校验 Publication 仍有效
8. 校验 Attestation 未撤销
9. 校验 Runtime Conformance
10. 校验 Capability 兼容
11. 调用 RouteSetActivationPolicy 验证目标集合
12. 为内容变化的 Route 创建新 RouteRevision
13. 为所有发生变化的 Route 创建 RouteActivation（routeSetId 派生自 RouteRevision）
14. 更新 DeploymentRoute 当前投影
15. 未出现在目标 Active 集合中的旧 Route 写 disabled Activation
16. RouteSet.versionNo 只增加一次
17. 所有本次 Activation 使用相同 routeSetVersionNo
18. 写聚合 Audit + 每条 Route Audit
19. 写 Outbox
20. 完成 Idempotency
21. 提交
22. 任一步失败全部回滚

### 现有单 Route 服务

保留 `upsertDeploymentRoute()` / `disableDeploymentRoute()`，改为薄适配器：
读取当前 RouteSet 目标状态 → 替换或禁用指定 Route → 调用 ActivateRouteSet

若产生非法中间状态 → `409 ROUTE_SET_REQUIRES_ATOMIC_UPDATE`

## 八、任务 1.6 — RouteSet 批量 API

### 新增

`PUT /admin/api/v1/deployment-route-sets/{route_set_id}/activation`

必填：`Idempotency-Key` header、`If-Match` header

请求体：
```json
{
  "expected_version_no": 3,
  "reason": "权重调整",
  "routes": [{
    "route_id": "可选",
    "agent_revision_id": "...",
    "runtime_revision_id": "...",
    "policy_revision_id": "可选",
    "model_policy_revision_id": "可选",
    "toolset_revision_id": "可选",
    "route_group_id": "primary",
    "traffic_weight": 5000,
    "priority_no": 0,
    "effective_from": "可选",
    "effective_until": "可选",
    "eligibility_conditions": {"all": {"environment": "prod"}},
    "activation_state": "active"
  }]
}
```

若保留 `expected_version_no`，必须与 `If-Match` 一致。

响应：
```json
{
  "route_set_id": "...",
  "route_set_version_no": 4,
  "activations": [],
  "affected_new_invocations_only": true
}
```

ETag 通过响应头返回：`route-set-{versionNo}`

同一 Idempotency-Key + 不同目标集合 → `409 IDEMPOTENCY_CONFLICT`

### 新增错误码

- `ROUTE_WEIGHT_TOTAL_INVALID`
- `ROUTE_GROUP_SELECTOR_MISMATCH`
- `ROUTE_SELECTOR_AMBIGUOUS`
- `ROUTE_SET_REQUIRES_ATOMIC_UPDATE`
- `ROUTE_REVISION_NOT_ELIGIBLE`
- `ROUTE_SET_VERSION_CONFLICT`

## 九、任务 1.7 — 修正 RouteResolver 裁决

### 修改文件
- `lib/routes/domain/route-resolution-policy.ts`
- `lib/routes/application/resolve-route.test.ts`
- `lib/routes/domain/route-resolution-policy.test.ts`

### 删除

Resolver 内部删除：`eligibilitySpecificity`、`sortKeys`、`compareResolutionPrecedence` 中的 Selector 逻辑。

Resolver + RouteSetActivationPolicy 共同调用 RouteSelector 的同一套：
`normalizeEligibility`、`computeSpecificity`、`computeSelectorDigest`、`isOverlapping`

### 新 Resolver 行为

1. 过滤不匹配或无资格候选
2. 最高 Specificity
3. 在其中最高 Priority
4. 剩余候选必须属于同一个 Route Group
5. Group 权重必须合计 10000
6. 按 deploymentRouteId 稳定排序
7. 使用 Business Key 稳定 Bucket

禁止：`routeRevisionNo`、`routeGroupId` 字典序、`routeRevisionId` 字典序 裁决业务冲突。

### 歧义处理

- 多 Group → `status: unresolved, reason: ambiguous_route_configuration`
- 权重错误 → `status: unresolved, reason: invalid_traffic_weight_total`

搜索并更新所有 Outcome 调用方（Dispatcher、Hosted 复验、管理诊断、测试）。

## 十、测试矩阵

### 10.1 Runtime 发布

- Attestation 和 Conformance 均有效 → 发布成功
- 缺少 Attestation → 发布失败
- Attestation 已撤销
- Attestation 绑定其他 Revision
- Artifact Digest 不一致
- Conformance 绑定其他 Revision
- Conformance Config Digest 不一致
- Conformance 缺 Case
- Conformance 存在失败 Case
- 并发发布只有一个权威 Publication
- Runtime 指针更新失败事务回滚
- Audit 失败回滚
- Outbox 失败回滚
- Idempotency 完成失败回滚
- 重试返回同一 PublicationRecord

### 10.2 RouteSet

- 单条 10000 权重激活
- 两条 5000/5000 原子激活
- 5000/4000 拒绝
- 50/50 原子变更为 70/30 成功
- 使用单 Route 接口先改 70 导致非法中间状态时拒绝
- 不同 Group 相同 Selector 和 Priority 拒绝
- 不同 Selector 且互斥时允许
- 更高 Specificity 覆盖低 Specificity
- 同 Selector 同 Group 按权重稳定分流
- RouteSet CAS 冲突完整回滚
- 任一 Route 资格失效完整回滚
- 同一 Idempotency-Key 不重复创建 Activation
- Resolver 不再通过字典序掩盖冲突

### 10.3 补充测试

1. 同 Group 成员时间窗口不一致 → 拒绝
2. 两个 Group Selector 重叠但时间不重叠 → 允许
3. 权重在未来时间边界会失去 10000 → 拒绝
4. Backfill 重复执行结果一致
5. 历史多 Route 无 Group ID 不全部错误归入 primary
6. If-Match 与 expected_version_no 不一致 → 拒绝
7. 所有 Resolver 调用方正确处理 ambiguous_route_configuration
8. 新 RouteSelector 与 ActivationPolicy 使用同一规范化结果
9. RouteActivation.routeSetId 不能与 RouteRevision 不一致
10. Store、Publication、Resolver 不再分别增加新的 Attestation 判断实现

## 十一、完成条件

1. 新 RuntimePublication 不允许空 attestationIds
2. Admin publish=true 必须提供 Attestation
3. Published RuntimeRevision 必然具备路由所需证明
4. 多 Route 权重调整可在一个事务完成
5. 非法 RouteSet 不能成功激活
6. Resolver 不再用 RevisionNo 或字典序裁决冲突
7. 原有单 Route API 保持兼容或返回明确冲突
8. 全部现有测试、类型检查、Lint 和 Build 通过
