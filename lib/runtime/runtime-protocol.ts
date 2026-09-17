/**
 * RuntimeProtocol — SnowHarness 平台与 Runtime 之间的唯一机器契约。
 *
 * Authority（工程包 sections/runtime-contract.md §7）：
 * - 唯一 protocolVersion = 3（JSON 整数）；代码类型统一叫 RuntimeProtocol、
 *   RuntimeStartRequest 等，路径与符号名不携带开发版本号。
 * - 只接受 HTTP JSON UTF-8；请求/响应字段 lowerCamelCase。
 * - 整数序号 / Epoch / BIGINT 均十进制字符串（不是 JSON 浮点数）。
 * - 拒绝重复 JSON key、未声明字段、非有限数值、非法 Unicode、超限 Payload。
 * - 摘要规则：sha256(JCS(semantic payload))；事件摘要覆盖 type/schemaVersion/payload；
 *   Start 摘要覆盖全部执行语义但排除 credentials、ContextHandle 签名文本、trace、
 *   发送时间和可续期 URL（被排除值的稳定资源身份仍必须包含于语义域）。
 *
 * 本模块只提供纯类型/常量/校验/摘要工具，不发起 HTTP，不读写数据库。
 * HTTP 传输由 lib/runtime/runtime-client.ts 承担；调用方迁移在 Runtime Batch 完成。
 */

import { createHash } from "node:crypto";
import { z } from "zod";

// ═══════════════════════════════════════════════════════════════════════════
// §7.1  Protocol / Contract / Format versions
// ═══════════════════════════════════════════════════════════════════════════

/** 唯一 Runtime 机器协议版本。JSON 整数，不是字符串。 */
export const PROTOCOL_VERSION = 3 as const;

/** WorkloadToken contractVersion。与 PROTOCOL_VERSION 独立演进但当前一致。 */
export const CONTRACT_VERSION = 3 as const;

/**
 * WorkloadToken 封装格式版本（header.formatVersion）。
 * 机器格式事实，不形成目录/类型版本名。
 */
export const WORKLOAD_TOKEN_FORMAT_VERSION = 1 as const;

/** WorkloadToken 签名算法固定值；不接受 Token 指定算法。 */
export const WORKLOAD_TOKEN_ALGORITHM = "HS256" as const;

/** WorkloadToken HMAC 域分离前缀，防止跨协议重放。 */
export const WORKLOAD_TOKEN_HMAC_DOMAIN = "snowharness.workload\0" as const;

/**
 * WorkloadToken audience 白名单。两种是权限隔离的受众，不是新旧 Contract。
 * CI/CD Service Identity 不伪装成 execution 凭据。
 */
export const WORKLOAD_TOKEN_AUDIENCES = ["runtime", "gateway"] as const;
export type WorkloadTokenAudience = (typeof WORKLOAD_TOKEN_AUDIENCES)[number];

// ═══════════════════════════════════════════════════════════════════════════
// §7.1  Payload / batch limits（Runtime 可声明更低值，Binding 冻结取更严格者）
// ═══════════════════════════════════════════════════════════════════════════

/** 单个 RuntimeEvent 最大字节数（256 KiB）。 */
export const MAX_EVENT_BYTES = 262_144 as const;

/** 单次批次最多事件条数。 */
export const MAX_BATCH_EVENTS = 100 as const;

/** 单次批次总字节上限（1 MiB）。 */
export const MAX_BATCH_BYTES = 1_048_576 as const;

/** issuedAt 允许的最大未来时钟容差（毫秒）。不用于数据库 Lease 判定。 */
export const MAX_ISSUED_AT_FUTURE_SKEW_MS = 5_000 as const;

// ═══════════════════════════════════════════════════════════════════════════
// §7.11  Transport retry policy
// ═══════════════════════════════════════════════════════════════════════════

/**
 * Transport 重试指数退避序列（毫秒）：1/2/4/8/16/30 秒。
 * 同意图同 digest 才重试，不越过 dispatchDeadline。
 */
export const TRANSPORT_RETRY_BACKOFF_MS = [1_000, 2_000, 4_000, 8_000, 16_000, 30_000] as const;

/** 抖动上限（0..20%）。 */
export const TRANSPORT_RETRY_JITTER_RATIO = 0.2 as const;

/** 连接建立超时（毫秒）。 */
export const TRANSPORT_CONNECT_TIMEOUT_MS = 3_000 as const;

/** 单请求超时（毫秒）。 */
export const TRANSPORT_REQUEST_TIMEOUT_MS = 15_000 as const;

/** 恢复 / Job 命令持久安排的最大退避（毫秒）。 */
export const RECOVERY_RETRY_MAX_BACKOFF_MS = 30_000 as const;

// ═══════════════════════════════════════════════════════════════════════════
// Primitive schemas — UUID / decimal string / digest
// ═══════════════════════════════════════════════════════════════════════════

/** UUID VARCHAR(36) 严格形式。 */
export const uuidSchema = z
  .string()
  .regex(
    /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i,
    "expected UUID (xxxxxxxx-xxxx-xxxx-xxxx-xxxxxxxxxxxx)",
  );

/**
 * BIGINT UNSIGNED 十进制字符串（跨 JS/JSON 边界不用 Number）。
 * 拒绝前导零、正负号、非数字。
 */
export const decimalStringSchema = z
  .string()
  .regex(/^(?:0|[1-9][0-9]*)$/, "expected non-negative decimal string");

/** 正整数十进制字符串（用于 leaseEpoch、producerSequence 等必须 > 0 的场景）。 */
export const positiveDecimalStringSchema = z
  .string()
  .regex(/^[1-9][0-9]*$/, "expected positive decimal string");

/**
 * 十进制字符串 → 本地安全整数（跨 JS/JSON 边界的唯一转换入口）。
 *
 * 超出 `Number.MAX_SAFE_INTEGER` 即拒绝：静默降精度会让 Authority/序列号比较
 * 出现假相等，宁可 fail closed。
 */
export function decimalStringToNumber(value: string): number {
  const result = Number(value);
  if (!Number.isSafeInteger(result))
    throw new RangeError(`decimal value exceeds local safe integer boundary: ${value}`);
  return result;
}

/** `sha256:<64 lowercase hex>` 摘要字符串。 */
export const sha256DigestSchema = z
  .string()
  .regex(/^sha256:[0-9a-f]{64}$/, "expected sha256:<64 lowercase hex>");

/** Unix 毫秒安全整数（用于 issuedAt / expiresAt / acceptedAt）。 */
export const unixMillisSchema = z.number().int().nonnegative().max(Number.MAX_SAFE_INTEGER);

// ═══════════════════════════════════════════════════════════════════════════
// §7.2  AuthorityIdentity — 所有执行相关请求必须具有
// ═══════════════════════════════════════════════════════════════════════════

/**
 * 统一 AuthorityIdentity。租户来自已认证身份，body 中的 tenantId 即使存在
 * 也必须与认证值一致；不由 Runtime 选租户。
 */
export const AuthorityIdentitySchema = z
  .object({
    invocationId: uuidSchema,
    runtimeRevisionId: uuidSchema,
    attemptId: uuidSchema,
    ownershipId: uuidSchema,
    leaseEpoch: positiveDecimalStringSchema,
    sessionBindingId: uuidSchema,
  })
  .strict();
export type AuthorityIdentity = z.infer<typeof AuthorityIdentitySchema>;

// ═══════════════════════════════════════════════════════════════════════════
// §7.3  Credentials envelope（替代旧 GatewayAccess.access_token 混杂命名）
// ═══════════════════════════════════════════════════════════════════════════

/**
 * Start / Resume / Heartbeat 交付的双受众凭据。
 * runtimeToken：audience=runtime，用于 Runtime→平台执行事实提交；
 * gatewayToken：audience=gateway，用于 Runtime→平台新 Action 请求。
 * Token 值仅传输，不持久化，不入业务表、trace 或模型 Context。
 */
export const CredentialsSchema = z
  .object({
    runtimeToken: z.string().min(1),
    gatewayToken: z.string().min(1),
    expiresAt: unixMillisSchema,
  })
  .strict();
export type Credentials = z.infer<typeof CredentialsSchema>;

// ═══════════════════════════════════════════════════════════════════════════
// §7.4  Capabilities — Subject types / Workspace modes / Filesystem semantics
// ═══════════════════════════════════════════════════════════════════════════

/** Invocation Subject 类型：thread 或 job。纯 Job 不依赖 Thread。 */
export const SubjectTypeSchema = z.enum(["thread", "job"]);
export type SubjectType = z.infer<typeof SubjectTypeSchema>;

/**
 * WorkspaceBinding 4 个正式业务模式（不是版本模式）。
 * 详见 sections/workspace-checkpoints.md 与 §二十六。
 */
export const WorkspaceModeSchema = z.enum([
  "HOST_AFFINE",
  "SHARED_DURABLE",
  "CHECKPOINT_RESTORABLE",
  "NO_PLATFORM_WORKSPACE",
]);
export type WorkspaceMode = z.infer<typeof WorkspaceModeSchema>;

/**
 * CHECKPOINT_RESTORABLE 声明必须同时证明的 4 项能力。
 * 未验证能力不能手工勾选；管理员 supportsCheckpoint=true 不代替真实一致性测试。
 */
export const CHECKPOINT_CAPABILITY_REQUIREMENTS = [
  "safePoint",
  "writerQuiescence",
  "snapshotExport",
  "snapshotRestore",
] as const;
export type CheckpointCapabilityRequirement = (typeof CHECKPOINT_CAPABILITY_REQUIREMENTS)[number];

/** 文件系统语义声明（用于 Redispatch 与实际 Lease 合规性校验）。 */
export const FilesystemSemanticsSchema = z
  .object({
    kind: z.string().min(1),
    caseSensitive: z.boolean(),
    symlinks: z.boolean(),
    permissions: z.boolean(),
    hardlinks: z.boolean(),
    specialFiles: z.boolean(),
    xattrsAcl: z.boolean(),
    mtime: z.string().min(1),
  })
  .strict();
export type FilesystemSemantics = z.infer<typeof FilesystemSemanticsSchema>;

/**
 * Runtime 必须能力集合。前 5 项固定为 true（协议要求）；resume/steer 为声明式
 * 可选能力（为 false 时发布套件只验证「不宣称支持」，不伪造成功）；后 3 项按真实
 * 能力收窄。
 * 发布 / Route 选择不得把不支持 Job 的 Runtime 用作 Job 执行；平台标准 Hosted
 * 实现必须两种 Subject 都支持。
 */
export const RuntimeFeaturesSchema = z
  .object({
    heartbeat: z.literal(true),
    durableStartIdempotency: z.literal(true),
    startedEvent: z.literal(true),
    exactReplay: z.literal(true),
    cancel: z.literal(true),
    resume: z.boolean(),
    steer: z.boolean(),
    subjectTypes: z.array(SubjectTypeSchema).min(1),
    workspaceModes: z.array(WorkspaceModeSchema).min(1),
    filesystemSemantics: FilesystemSemanticsSchema,
  })
  .strict();
export type RuntimeFeatures = z.infer<typeof RuntimeFeaturesSchema>;

/** Runtime 声明的可收窄限制（不得超过协议上限）。 */
export const RuntimeLimitsSchema = z
  .object({
    maxEventBytes: z.number().int().positive().max(MAX_EVENT_BYTES),
    maxBatchEvents: z.number().int().positive().max(MAX_BATCH_EVENTS),
    maxBatchBytes: z.number().int().positive().max(MAX_BATCH_BYTES),
  })
  .strict();
export type RuntimeLimits = z.infer<typeof RuntimeLimitsSchema>;

/**
 * GET <runtimeBase>/runtime/capabilities 响应。
 * Capabilities 不是 Current Authority，不会给 Caller 租约。
 */
export const RuntimeCapabilitiesSchema = z
  .object({
    protocolVersion: z.literal(PROTOCOL_VERSION),
    contractDigest: sha256DigestSchema,
    runtimeTargetDigest: sha256DigestSchema,
    features: RuntimeFeaturesSchema,
    limits: RuntimeLimitsSchema,
  })
  .strict();
export type RuntimeCapabilities = z.infer<typeof RuntimeCapabilitiesSchema>;

// ═══════════════════════════════════════════════════════════════════════════
// §7.5  Start / Resume — 请求子结构
// ═══════════════════════════════════════════════════════════════════════════

/** intentType 区分 Start 与 Resume；必须匹配 path 和持久启动意图。 */
export const IntentTypeSchema = z.enum(["start", "resume"]);
export type IntentType = z.infer<typeof IntentTypeSchema>;

/**
 * ExecutionBinding 冻结摘要与执行条件引用（不可变）。
 * 具体 policy/governance/capability/model 引用为稳定资源身份 UUID。
 */
export const ExecutionBindingSchema = z
  .object({
    bindingDigest: sha256DigestSchema,
    runtimeRevisionId: uuidSchema,
    policyRefs: z.array(uuidSchema),
    governanceRefs: z.array(uuidSchema),
    capabilityRefs: z.array(uuidSchema),
    modelRefs: z.array(uuidSchema),
    allowedEgress: z.array(z.string().min(1)),
  })
  .strict();
export type ExecutionBinding = z.infer<typeof ExecutionBindingSchema>;

/**
 * T33：ContextHandle 暴露的初始压缩材料受控引用与内容 digest。
 *
 * 只暴露稳定身份与内容摘要，不暴露任意可替换对象；summary 正文由平台经
 * Context 装配下发，不放进句柄。字段缺失代表「Binding 未选择初始材料」。
 */
export const ContextInitialCompressionSchema = z
  .object({
    checkpointId: uuidSchema,
    summaryHash: sha256DigestSchema,
    sourceRangesHash: sha256DigestSchema,
  })
  .strict();
export type ContextInitialCompression = z.infer<typeof ContextInitialCompressionSchema>;

/**
 * ContextHandle wire envelope（§三十二）。
 * Common envelope + subject.type 判别式（thread / job）。
 * Handle 签名文本不入 Start 请求 digest（§7.1 排除域）；
 * 稳定资源身份 threadId / jobId / turnId 仍进入语义域。
 *
 * T33：`initialCompression` 是同一契约的显式字段（未选择时为 null），
 * 不提供旧/新 decoder 双轨。
 */
export const ContextHandleCommonSchema = z
  .object({
    contractVersion: z.literal(1),
    tenantId: uuidSchema,
    invocationId: uuidSchema,
    bindingDigest: sha256DigestSchema,
    initialCompression: ContextInitialCompressionSchema.nullable(),
    principal: z
      .object({
        type: z.enum(["user", "service"]),
        id: z.string().min(1),
        source: z.enum(["authenticated_user", "trusted_service"]),
      })
      .strict(),
    runtimeRevisionId: uuidSchema,
    policy: z.object({ revisionId: uuidSchema, digest: sha256DigestSchema }).strict(),
    workspace: z.object({ bindingId: uuidSchema, contractDigest: sha256DigestSchema }).strict(),
    environment: z.discriminatedUnion("mode", [
      z
        .object({
          mode: z.literal("MANAGED"),
          revisionId: uuidSchema,
          semanticDigest: sha256DigestSchema,
        })
        .strict(),
      z.object({ mode: z.literal("NO_PLATFORM_ENVIRONMENT") }).strict(),
    ]),
    contextSourceDigest: sha256DigestSchema,
    issuedAt: unixMillisSchema,
    expiresAt: unixMillisSchema,
    jti: uuidSchema,
  })
  .strict();

export const ContextHandleThreadSubjectSchema = z
  .object({
    type: z.literal("thread"),
    threadId: uuidSchema,
    turnId: uuidSchema,
    triggerItemId: uuidSchema,
    triggerItemDigest: sha256DigestSchema,
  })
  .strict();

export const ContextHandleJobSubjectSchema = z
  .object({
    type: z.literal("job"),
    jobId: uuidSchema,
    inputKind: z.enum(["inline", "reference"]),
    inputHash: sha256DigestSchema,
    inputRef: z.string().min(1).optional(),
    triggerRef: z.string().min(1),
    replacesJobId: uuidSchema.optional(),
  })
  .strict()
  .refine(
    (value) =>
      value.inputKind === "reference" ? Boolean(value.inputRef) : value.inputRef === undefined,
    {
      message: "job inputRef must match inputKind",
    },
  );

export const ContextHandleSubjectSchema = z.discriminatedUnion("type", [
  ContextHandleThreadSubjectSchema,
  ContextHandleJobSubjectSchema,
]);

export const ContextHandleSchema = z
  .object({
    common: ContextHandleCommonSchema,
    subject: ContextHandleSubjectSchema,
  })
  .strict();
export type ContextHandle = z.infer<typeof ContextHandleSchema>;

/** 持久来源输入或规范 inline 值；Job 不得带假 triggerItem。 */
export const InputSchema = z
  .object({
    kind: z.enum(["persistent_ref", "inline"]),
    ref: z.string().min(1).optional(),
    digest: sha256DigestSchema,
  })
  .strict()
  .refine((v) => (v.kind === "persistent_ref" ? Boolean(v.ref) : v.ref === undefined), {
    message: "persistent_ref requires ref; inline forbids ref",
  });
export type Input = z.infer<typeof InputSchema>;

/** Environment 选择：MANAGED（绑 Revision）或 NO_PLATFORM_ENVIRONMENT。 */
export const EnvironmentSchema = z.discriminatedUnion("mode", [
  z
    .object({
      mode: z.literal("MANAGED"),
      revisionId: uuidSchema,
      semanticDigest: sha256DigestSchema,
    })
    .strict(),
  z
    .object({
      mode: z.literal("NO_PLATFORM_ENVIRONMENT"),
    })
    .strict(),
]);
export type Environment = z.infer<typeof EnvironmentSchema>;

/** Workspace 声明：NONE 明确表达，或 binding + contract + continuity + activation。 */
export const WorkspaceSchema = z.discriminatedUnion("mode", [
  z
    .object({
      mode: z.literal("NONE"),
    })
    .strict(),
  z
    .object({
      mode: z.literal("BOUND"),
      bindingId: uuidSchema,
      contractDigest: sha256DigestSchema,
      continuityMode: WorkspaceModeSchema,
      activationEvidenceRef: z.string().min(1),
    })
    .strict(),
]);
export type Workspace = z.infer<typeof WorkspaceSchema>;

/** Recovery 意图：initial 或 resume（anchor + digest + 可选 checkpointId）。 */
export const RecoverySchema = z.discriminatedUnion("kind", [
  z
    .object({
      kind: z.literal("initial"),
    })
    .strict(),
  z
    .object({
      kind: z.literal("resume"),
      anchor: z.string().min(1),
      anchorDigest: sha256DigestSchema,
      checkpointId: uuidSchema.optional(),
    })
    .strict(),
]);
export type Recovery = z.infer<typeof RecoverySchema>;

/**
 * 平台受管回调端点集合。不包含允许 Runtime 自调 Takeover 的入口。
 * 所有 URL 必须 HTTPS 或同机可信 IPC；不得从模型输入拼接。
 */
export const CallbackEndpointsSchema = z
  .object({
    events: z.string().url(),
    heartbeat: z.string().url(),
    context: z.string().url(),
    capabilityActions: z.string().url(),
    toolCalls: z.string().url(),
    userActions: z.string().url(),
  })
  .strict();
export type CallbackEndpoints = z.infer<typeof CallbackEndpointsSchema>;

/** 冻结执行限制；不能由 Runtime 放大。 */
export const ExecutionLimitsSchema = z
  .object({
    maxEventBytes: z.number().int().positive().max(MAX_EVENT_BYTES),
    maxBatchEvents: z.number().int().positive().max(MAX_BATCH_EVENTS),
    maxBatchBytes: z.number().int().positive().max(MAX_BATCH_BYTES),
    dispatchDeadlineMs: z.number().int().positive(),
    executionTimeoutMs: z.number().int().positive(),
  })
  .strict();
export type ExecutionLimits = z.infer<typeof ExecutionLimitsSchema>;

/** 诊断上下文，不参与执行身份，不进入 Start digest。 */
export const TraceContextSchema = z
  .object({
    traceId: z.string().min(1),
    spanId: z.string().min(1).optional(),
    parentSpanId: z.string().min(1).optional(),
  })
  .strict();
export type TraceContext = z.infer<typeof TraceContextSchema>;

/**
 * POST /runtime/invocations 与 POST /runtime/invocations/{invocationId}/resume
 * 使用同一 RuntimeStartRequest 结构，通过 intentType 区分。
 * Header `Idempotency-Key = start:{ownershipId}`，不包含 Token JTI，
 * 不随网络重试变化。
 */
export const RuntimeStartRequestSchema = z
  .object({
    protocolVersion: z.literal(PROTOCOL_VERSION),
    authority: AuthorityIdentitySchema,
    intentType: IntentTypeSchema,
    semanticRequestDigest: sha256DigestSchema,
    executionBinding: ExecutionBindingSchema,
    context: ContextHandleSchema,
    inputs: z.array(InputSchema).min(1),
    environment: EnvironmentSchema,
    workspace: WorkspaceSchema,
    activationDigest: sha256DigestSchema,
    recovery: RecoverySchema,
    producerSequenceStart: positiveDecimalStringSchema,
    callbackEndpoints: CallbackEndpointsSchema,
    credentials: CredentialsSchema,
    executionLimits: ExecutionLimitsSchema,
    traceContext: TraceContextSchema.optional(),
  })
  .strict();
export type RuntimeStartRequest = z.infer<typeof RuntimeStartRequestSchema>;

/**
 * HTTP 202 响应 = Transport 接纳证据，不是运行事实。
 * 远端接纳必须先持久保存启动身份、digest、唯一 remote refs，再回应或发起用户任务。
 */
export const RuntimeStartResponseSchema = z
  .object({
    protocolVersion: z.literal(PROTOCOL_VERSION),
    authority: AuthorityIdentitySchema,
    semanticRequestDigest: sha256DigestSchema,
    accepted: z.literal(true),
    remoteSessionRef: z.string().min(1),
    remoteExecutionRef: z.string().min(1),
    capabilitiesDigest: sha256DigestSchema,
    acceptedAt: unixMillisSchema,
  })
  .strict();
export type RuntimeStartResponse = z.infer<typeof RuntimeStartResponseSchema>;

// ═══════════════════════════════════════════════════════════════════════════
// §7.6  Heartbeat
// ═══════════════════════════════════════════════════════════════════════════

/** Runtime 自报的执行状态；不含 suspended（暂停由 execution.suspended 事件表达）。 */
export const HeartbeatRuntimeStateSchema = z.enum(["starting", "running", "suspending"]);
export type HeartbeatRuntimeState = z.infer<typeof HeartbeatRuntimeStateSchema>;

/**
 * POST /runtime/invocations/{invocationId}/heartbeat, audience=runtime.
 * Heartbeat 只 renew 当前未过期 Owner；旧心跳、旧 Owner、错 Session 都不能续租。
 */
export const HeartbeatRequestSchema = z
  .object({
    protocolVersion: z.literal(PROTOCOL_VERSION),
    authority: AuthorityIdentitySchema,
    heartbeatId: uuidSchema,
    runtimeState: HeartbeatRuntimeStateSchema,
    lastObservedProducerSequence: decimalStringSchema,
    requestCredentialRefresh: z.boolean(),
  })
  .strict();
export type HeartbeatRequest = z.infer<typeof HeartbeatRequestSchema>;

/**
 * 失败时 continueExecution=false，Runtime 立即停止接纳新用户 Action
 * 并进入受控停止流程。renewedCredentials 只在成功后按需返回。
 */
export const HeartbeatResponseSchema = z
  .object({
    protocolVersion: z.literal(PROTOCOL_VERSION),
    authority: AuthorityIdentitySchema,
    serverTime: unixMillisSchema,
    leaseExpiresAt: unixMillisSchema,
    acceptedThroughProducerSequence: decimalStringSchema,
    continueExecution: z.boolean(),
    renewedCredentials: CredentialsSchema.optional(),
  })
  .strict();
export type HeartbeatResponse = z.infer<typeof HeartbeatResponseSchema>;

// ═══════════════════════════════════════════════════════════════════════════
// §7.7  Event Batch
// ═══════════════════════════════════════════════════════════════════════════

/**
 * 正式事件类型集合。execution.started 唯一推进 Session/Attempt/Invocation 运行；
 * execution.suspended 由平台验证安全边界后才正式暂停并释放 Owner。
 * response.completed 生成产品内容，不自动当 execution.completed。
 */
export const RuntimeEventTypeSchema = z.enum([
  "execution.started",
  "execution.suspended",
  "execution.completed",
  "execution.failed",
  "execution.cancelled",
  "progress",
  "response.completed",
  "user-action",
  "action",
  "terminal",
  // Harness 行动事实（RUNTIME_EVENT_INGRESS_TYPES 同款）；由平台 Gateway/Hosted Loop 产生，
  // mysql-recovery-port 依赖该 candidateType 前缀重建 durable action 历史。
  "harness.action.proposed",
  "harness.action.started",
  "harness.action.completed",
  "harness.action.failed",
  // Job 内部正式阶段操作事实：ownerRef = 已提交的 job.step.accepted 事件 Ingress id；
  // 不新建版本目录或兼容 handler，step 事实本身不建立新表。
  "job.step.accepted",
  "job.step.completed",
  "job.step.failed",
]);
export type RuntimeEventType = z.infer<typeof RuntimeEventTypeSchema>;

/**
 * 单个 RuntimeEvent。eventId / producerSequence / payloadHash 只解决幂等和顺序，
 * 不能代替 Fencing（INV-04）；接纳事务必须先验证 Authority。
 */
export const RuntimeEventSchema = z
  .object({
    eventId: uuidSchema,
    producerSequence: positiveDecimalStringSchema,
    type: RuntimeEventTypeSchema,
    schemaVersion: z.number().int().positive(),
    payload: z.record(z.string(), z.unknown()),
  })
  .strict();
export type RuntimeEvent = z.infer<typeof RuntimeEventSchema>;

/**
 * POST /runtime/invocations/{invocationId}/events, audience=runtime.
 * Batch envelope 不另造持久幂等对象；幂等主体是每个 Event。
 */
export const RuntimeEventBatchSchema = z
  .object({
    protocolVersion: z.literal(PROTOCOL_VERSION),
    authority: AuthorityIdentitySchema,
    events: z.array(RuntimeEventSchema).min(1).max(MAX_BATCH_EVENTS),
  })
  .strict();
export type RuntimeEventBatch = z.infer<typeof RuntimeEventBatchSchema>;

/** Event 回执内映射引用（Thread Item / Thread Event / Job Event 等一次性保存）。 */
export const EventMappedReferencesSchema = z
  .object({
    itemId: uuidSchema.optional(),
    threadEventId: uuidSchema.optional(),
    jobEventId: uuidSchema.optional(),
  })
  .strict();
export type EventMappedReferences = z.infer<typeof EventMappedReferencesSchema>;

/**
 * 逐事件固定回执。精确历史 Replay 返回原回执，response delivery 标注 `replayed`
 * 但不修改原 receipt。回执不包含"你现在可以运行"的许可。
 */
export const EventReceiptSchema = z
  .object({
    eventId: uuidSchema,
    producerSequence: positiveDecimalStringSchema,
    ingressId: uuidSchema,
    acceptedAt: unixMillisSchema,
    acceptedAuthority: AuthorityIdentitySchema,
    mappedReferences: EventMappedReferencesSchema,
    recoveryVersionAfter: decimalStringSchema,
  })
  .strict();
export type EventReceipt = z.infer<typeof EventReceiptSchema>;

// ═══════════════════════════════════════════════════════════════════════════
// §7.8 / §7.9 / §7.10  Cancel / Steer / Safe-point
// ═══════════════════════════════════════════════════════════════════════════

/** Cancel 停止状态。 */
export const CancelStopStateSchema = z.enum(["requested", "stopped"]);
export type CancelStopState = z.infer<typeof CancelStopStateSchema>;

/**
 * POST <runtimeBase>/runtime/invocations/{id}/cancel
 * Idempotency-Key = command:{InvocationCommand.id}
 * 必须精确针对指定 generation，不得收到旧 Cancel 就停止当前新 Owner。
 */
export const CancelRequestSchema = z
  .object({
    protocolVersion: z.literal(PROTOCOL_VERSION),
    commandId: uuidSchema,
    targetAuthority: AuthorityIdentitySchema,
    reasonCode: z.string().min(1),
  })
  .strict();
export type CancelRequest = z.infer<typeof CancelRequestSchema>;

export const CancelResponseSchema = z
  .object({
    accepted: z.boolean(),
    targetAuthority: AuthorityIdentitySchema,
    stopState: CancelStopStateSchema,
    cleanupEvidence: z.string().min(1).optional(),
  })
  .strict();
export type CancelResponse = z.infer<typeof CancelResponseSchema>;

/**
 * POST <runtimeBase>/runtime/invocations/{id}/steer
 * 输入先由产品 / Job 授权入口持久接纳，命令仅传正式引用。
 * 重复 commandId + 同 digest 返回原 Ack；不同 payload 冲突。
 */
export const SteerRequestSchema = z
  .object({
    protocolVersion: z.literal(PROTOCOL_VERSION),
    commandId: uuidSchema,
    targetAuthority: AuthorityIdentitySchema,
    inputRef: z.string().min(1),
    inputDigest: sha256DigestSchema,
  })
  .strict();
export type SteerRequest = z.infer<typeof SteerRequestSchema>;

export const SteerResponseSchema = z
  .object({
    accepted: z.boolean(),
    commandId: uuidSchema,
    targetAuthority: AuthorityIdentitySchema,
    inputDigest: sha256DigestSchema,
  })
  .strict();
export type SteerResponse = z.infer<typeof SteerResponseSchema>;

/**
 * POST <runtimeBase>/runtime/invocations/{id}/safe-points
 * 及 POST .../safe-points/{intentId}/release
 * 由既有 InvocationCommand(commandType=checkpoint) 持久交付。
 * Runtime 停止新 Action 并配合 WorkspaceHost 收口 Writer；响应只能提供
 * 安全点证据，不能自行写 FilesystemCheckpoint。
 */
export const SafePointRequestSchema = z
  .object({
    protocolVersion: z.literal(PROTOCOL_VERSION),
    targetAuthority: AuthorityIdentitySchema,
    checkpointIntentId: uuidSchema,
    deadlineMs: unixMillisSchema,
    expectedRecoveryAnchorDigest: sha256DigestSchema,
  })
  .strict();
export type SafePointRequest = z.infer<typeof SafePointRequestSchema>;

export const SafePointReleaseRequestSchema = z
  .object({
    protocolVersion: z.literal(PROTOCOL_VERSION),
    targetAuthority: AuthorityIdentitySchema,
    checkpointIntentId: uuidSchema,
  })
  .strict();
export type SafePointReleaseRequest = z.infer<typeof SafePointReleaseRequestSchema>;

export const SafePointResponseSchema = z
  .object({
    accepted: z.boolean(),
    checkpointIntentId: uuidSchema,
    safePointEvidenceDigest: sha256DigestSchema,
    writerQuiescenceAchievedAt: unixMillisSchema,
  })
  .strict();
export type SafePointResponse = z.infer<typeof SafePointResponseSchema>;

// ═══════════════════════════════════════════════════════════════════════════
// §7.11  Transport / Authority error codes
// ═══════════════════════════════════════════════════════════════════════════

/**
 * 401/403 不重试；409 明确区分 SequenceGap（可按服务端已接纳水位重发）
 * 与 Identity/PayloadConflict（停止该提交，不转成功）；
 * LeaseExpired / NotCurrentExecutor 不能发新 Token 自行复活。
 * 只有正式平台 Recovery 可建立新 generation。
 */
export const RuntimeErrorCodeSchema = z.enum([
  "ProtocolVersionUnsupported",
  "StartIntentConflict",
  "NotCurrentExecutor",
  "OwnershipExpired",
  "HealthyOwnerExists",
  "AttemptMismatch",
  "RuntimeSessionMismatch",
  "EventPayloadConflict",
  "ProducerSequenceGap",
  "InputDigestMismatch",
  "EnvironmentRevisionMismatch",
  "EnvironmentComplianceFailed",
  "WorkspaceNotReady",
  "WorkspaceWriterNotFenced",
  "CheckpointStale",
  "CheckpointIntegrityFailed",
  "EffectUnresolved",
]);
export type RuntimeErrorCode = z.infer<typeof RuntimeErrorCodeSchema>;

// ═══════════════════════════════════════════════════════════════════════════
// §7.1  JCS (RFC 8785) canonicalization + sha256 digest
// ═══════════════════════════════════════════════════════════════════════════

/**
 * RFC 8785 JSON Canonicalization Scheme.
 *
 * 规则：
 * 1. 对象成员按 key 的 UTF-16 code unit 递增排序（不做 Unicode 归一化）。
 * 2. 数字使用 ECMAScript Number::toString（最短可往返表示）。
 * 3. 字符串使用严格转义：仅 " \\ 与控制字符 U+0000..U+001F 转义；
 *    其他字符（含 U+2028/U+2029）原样输出。
 * 4. 数组保留顺序。
 * 5. 无空白。
 * 6. 拒绝非有限数值（NaN/±Infinity）、undefined、bigint、循环引用、非法 Unicode。
 *
 * 该实现不引入外部依赖；被 RuntimeProtocol 摘要规则唯一使用。
 */
export function canonicalizeJson(value: unknown): string {
  return serializeJcs(value, new Set<object>());
}

function serializeJcs(value: unknown, seen: Set<object>): string {
  if (value === null) return "null";
  if (typeof value === "boolean") return value ? "true" : "false";
  if (typeof value === "number") {
    if (!Number.isFinite(value)) {
      throw new TypeError(`JCS rejects non-finite number: ${String(value)}`);
    }
    // ECMAScript Number::toString 是最短可往返表示。
    return Object.is(value, -0) ? "0" : value.toString();
  }
  if (typeof value === "bigint") {
    throw new TypeError("JCS rejects bigint; encode as decimal string before canonicalization");
  }
  if (typeof value === "string") return serializeJcsString(value);
  if (typeof value === "undefined" || typeof value === "function" || typeof value === "symbol") {
    throw new TypeError(`JCS rejects ${typeof value}`);
  }
  if (Array.isArray(value)) {
    if (seen.has(value)) throw new TypeError("JCS rejects circular reference");
    seen.add(value);
    try {
      const parts = value.map((item) => {
        if (item === undefined) {
          throw new TypeError("JCS rejects undefined inside array");
        }
        return serializeJcs(item, seen);
      });
      return `[${parts.join(",")}]`;
    } finally {
      seen.delete(value);
    }
  }
  // Plain object
  if (typeof value !== "object") {
    throw new TypeError(`JCS rejects ${typeof value}`);
  }
  const record = value as Record<string, unknown>;
  if (seen.has(record)) throw new TypeError("JCS rejects circular reference");
  seen.add(record);
  try {
    const keys = Object.keys(record).filter((k) => record[k] !== undefined);
    // RFC 8785 §3.2.3: 按 UTF-16 code unit 递增排序（Array.sort 默认即按 code unit）
    keys.sort();
    const parts = keys.map((k) => `${serializeJcsString(k)}:${serializeJcs(record[k], seen)}`);
    return `{${parts.join(",")}}`;
  } finally {
    seen.delete(record);
  }
}

/** RFC 8785 §3.2.2 严格字符串转义。 */
function serializeJcsString(input: string): string {
  let out = '"';
  for (let i = 0; i < input.length; i += 1) {
    const code = input.charCodeAt(i);
    const ch = input[i];
    if (ch === '"' || ch === "\\") {
      out += `\\${ch}`;
      continue;
    }
    if (code === 0x08) {
      out += "\\b";
      continue;
    }
    if (code === 0x09) {
      out += "\\t";
      continue;
    }
    if (code === 0x0a) {
      out += "\\n";
      continue;
    }
    if (code === 0x0c) {
      out += "\\f";
      continue;
    }
    if (code === 0x0d) {
      out += "\\r";
      continue;
    }
    if (code < 0x20) {
      out += `\\u${code.toString(16).padStart(4, "0")}`;
      continue;
    }
    // 拒绝 lone surrogate（非法 Unicode）
    if (code >= 0xd800 && code <= 0xdbff) {
      const next = input.charCodeAt(i + 1);
      if (!(next >= 0xdc00 && next <= 0xdfff)) {
        throw new TypeError(`JCS rejects lone high surrogate at index ${i}`);
      }
      // 合法代理对：原样输出两个 code unit，跳过低位
      out += ch;
      out += input[i + 1];
      i += 1;
      continue;
    }
    if (code >= 0xdc00 && code <= 0xdfff) {
      throw new TypeError(`JCS rejects lone low surrogate at index ${i}`);
    }
    out += ch;
  }
  return `${out}"`;
}

/**
 * 计算 sha256(JCS(payload))，返回 `sha256:<64 lowercase hex>`。
 * 所有 RuntimeProtocol 摘要（bindingDigest / semanticRequestDigest /
 * contractDigest / activationDigest / anchorDigest / payloadHash / inputDigest /
 * capabilitiesDigest 等）必须经此函数产生。
 */
export function protocolDigest(payload: unknown): string {
  const canonical = canonicalizeJson(payload);
  return `sha256:${createHash("sha256").update(canonical, "utf8").digest("hex")}`;
}

// ═══════════════════════════════════════════════════════════════════════════
// §7.1  Start digest exclusion domains
// ═══════════════════════════════════════════════════════════════════════════

/**
 * Start 摘要覆盖全部执行语义，但排除以下域：
 * - credentials（Token 值不入 digest）
 * - ContextHandle 签名文本（稳定资源身份仍进入语义域）
 * - traceContext（诊断，不参与执行身份）
 * - 发送时间戳（acceptedAt / issuedAt / expiresAt 等易变时间）
 * - 可续期 URL（callbackEndpoints 里的短期签名 URL）
 *
 * 被排除值的**稳定资源身份**（threadId / jobId / invocationId / ownershipId 等）
 * 仍必须包含于语义域。
 */
export const START_DIGEST_EXCLUDED_FIELDS = [
  "credentials",
  "traceContext",
  "callbackEndpoints",
] as const;
export type StartDigestExcludedField = (typeof START_DIGEST_EXCLUDED_FIELDS)[number];

/**
 * 从 RuntimeStartRequest 构造语义摘要输入：
 * - 剔除 credentials / traceContext / callbackEndpoints 三个顶层字段
 * - context 保留 common + subject（稳定资源身份），签名文本由 transport 层附加
 *   而非请求 body，因此 context 对象本身可整体进入 digest
 * - 保留 protocolVersion / authority / intentType / executionBinding / inputs /
 *   environment / workspace / activationDigest / recovery / producerSequenceStart /
 *   executionLimits 全部执行语义字段
 */
export function buildStartSemanticDigestInput(
  request: RuntimeStartRequest,
): Record<string, unknown> {
  const {
    semanticRequestDigest: _semanticRequestDigest,
    credentials: _credentials,
    traceContext: _trace,
    callbackEndpoints: _cb,
    ...semantic
  } = request;
  void _semanticRequestDigest;
  void _credentials;
  void _trace;
  void _cb;
  const common = semantic.context?.common;
  if (common && typeof common === "object") {
    const {
      issuedAt: _issuedAt,
      expiresAt: _expiresAt,
      jti: _jti,
      ...stableCommon
    } = common as Record<string, unknown>;
    void _issuedAt;
    void _expiresAt;
    void _jti;
    return {
      ...semantic,
      context: {
        ...semantic.context,
        common: stableCommon,
      },
    };
  }
  return semantic;
}

/**
 * 计算 RuntimeStartRequest 的 semanticRequestDigest。
 * 该摘要必须与 RuntimeSessionBinding 冻结的语义请求一致；
 * 相同启动身份 + 相同 digest → 返回同一 remote execution；
 * 相同启动身份 + 不同 digest → StartIntentConflict（不能换新 Key 逃避冲突）。
 */
export function computeSemanticRequestDigest(request: RuntimeStartRequest): string {
  return protocolDigest(buildStartSemanticDigestInput(request));
}

/**
 * 计算单个 RuntimeEvent 的 payloadHash。
 * 事件摘要覆盖 type / schemaVersion / payload；eventId / sequence / authority
 * 另作严格匹配（不进入 payloadHash）。
 */
export function computeEventPayloadHash(event: RuntimeEvent): string {
  return protocolDigest({
    type: event.type,
    schemaVersion: event.schemaVersion,
    payload: event.payload,
  });
}

/**
 * 计算 RuntimeCapabilities 的 contractDigest（发布 / Conformance 冻结）。
 * 覆盖 protocolVersion / features / limits；runtimeTargetDigest 单独存在，
 * 不重复进入 contractDigest。
 */
export function computeCapabilitiesContractDigest(
  capabilities: Pick<RuntimeCapabilities, "protocolVersion" | "features" | "limits">,
): string {
  return protocolDigest({
    protocolVersion: capabilities.protocolVersion,
    features: capabilities.features,
    limits: capabilities.limits,
  });
}

// ═══════════════════════════════════════════════════════════════════════════
// Idempotency key helpers
// ═══════════════════════════════════════════════════════════════════════════

/**
 * Start / Resume 幂等键：`start:{ownershipId}`。
 * 不包含 Token JTI，不随网络重试变化。
 */
export function buildStartIdempotencyKey(ownershipId: string): string {
  return `start:${ownershipId}`;
}

/** Cancel / Steer 幂等键：`command:{InvocationCommand.id}`。 */
export function buildCommandIdempotencyKey(commandId: string): string {
  return `command:${commandId}`;
}
