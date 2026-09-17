import { describe, expect, it } from "vitest";

import {
  AuthorityIdentitySchema,
  CONTRACT_VERSION,
  CallbackEndpointsSchema,
  ContextHandleSchema,
  CredentialsSchema,
  EnvironmentSchema,
  ExecutionBindingSchema,
  ExecutionLimitsSchema,
  HeartbeatRequestSchema,
  IntentTypeSchema,
  MAX_BATCH_BYTES,
  MAX_BATCH_EVENTS,
  MAX_EVENT_BYTES,
  MAX_ISSUED_AT_FUTURE_SKEW_MS,
  PROTOCOL_VERSION,
  RECOVERY_RETRY_MAX_BACKOFF_MS,
  RuntimeCapabilitiesSchema,
  RuntimeErrorCodeSchema,
  RuntimeEventBatchSchema,
  RuntimeEventSchema,
  RuntimeEventTypeSchema,
  RuntimeStartRequestSchema,
  RuntimeStartResponseSchema,
  START_DIGEST_EXCLUDED_FIELDS,
  SafePointRequestSchema,
  SubjectTypeSchema,
  TRANSPORT_CONNECT_TIMEOUT_MS,
  TRANSPORT_REQUEST_TIMEOUT_MS,
  TRANSPORT_RETRY_BACKOFF_MS,
  TRANSPORT_RETRY_JITTER_RATIO,
  WORKLOAD_TOKEN_ALGORITHM,
  WORKLOAD_TOKEN_AUDIENCES,
  WORKLOAD_TOKEN_FORMAT_VERSION,
  WORKLOAD_TOKEN_HMAC_DOMAIN,
  WorkspaceModeSchema,
  buildCommandIdempotencyKey,
  buildStartIdempotencyKey,
  buildStartSemanticDigestInput,
  canonicalizeJson,
  computeCapabilitiesContractDigest,
  computeEventPayloadHash,
  computeSemanticRequestDigest,
  decimalStringSchema,
  positiveDecimalStringSchema,
  protocolDigest,
  sha256DigestSchema,
  unixMillisSchema,
  uuidSchema,
} from "./runtime-protocol";

// ─── Fixtures ──────────────────────────────────────────────────────────────

const INVOCATION_ID = "11111111-1111-4111-8111-111111111111";
const RUNTIME_REVISION_ID = "22222222-2222-4222-8222-222222222222";
const ATTEMPT_ID = "33333333-3333-4333-8333-333333333333";
const OWNERSHIP_ID = "44444444-4444-4444-8444-444444444444";
const SESSION_BINDING_ID = "55555555-5555-4555-8555-555555555555";
const TENANT_ID = "66666666-6666-4666-8666-666666666666";
const EXECUTION_BINDING_ID = "77777777-7777-4777-8777-777777777777";
const POLICY_REF = "88888888-8888-4888-8888-888888888888";
const WORKSPACE_BINDING_ID = "99999999-9999-4999-8999-999999999999";
const ENV_REVISION_ID = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";
const THREAD_ID = "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb";
const TURN_ID = "cccccccc-cccc-4ccc-8ccc-cccccccccccc";
const TRIGGER_ITEM_ID = "dddddddd-dddd-4ddd-8ddd-dddddddddddd";
const EVENT_ID = "eeeeeeee-eeee-4eee-8eee-eeeeeeeeeeee";
const INGRESS_ID = "ffffffff-ffff-4fff-8fff-ffffffffffff";

const DIGEST_A = `sha256:${"a".repeat(64)}`;
const DIGEST_B = `sha256:${"b".repeat(64)}`;

const validAuthority = {
  invocationId: INVOCATION_ID,
  runtimeRevisionId: RUNTIME_REVISION_ID,
  attemptId: ATTEMPT_ID,
  ownershipId: OWNERSHIP_ID,
  leaseEpoch: "7",
  sessionBindingId: SESSION_BINDING_ID,
};

const validCredentials = {
  runtimeToken: "wh.runtime.token.value",
  gatewayToken: "wh.gateway.token.value",
  expiresAt: 1_800_000_000_000,
};

const validCallbackEndpoints = {
  events: "https://platform.example/runtime/invocations/x/events",
  heartbeat: "https://platform.example/runtime/invocations/x/heartbeat",
  context: "https://platform.example/gateway/context/query",
  capabilityActions: "https://platform.example/gateway/capability-actions",
  toolCalls: "https://platform.example/gateway/tool-calls",
  userActions: "https://platform.example/gateway/user-action-requests",
};

const validExecutionBinding = {
  bindingDigest: DIGEST_A,
  runtimeRevisionId: RUNTIME_REVISION_ID,
  policyRefs: [POLICY_REF],
  governanceRefs: [],
  capabilityRefs: [],
  modelRefs: [],
  allowedEgress: ["api.example"],
};

const validContext = {
  common: {
    contractVersion: 1 as const,
    tenantId: TENANT_ID,
    invocationId: INVOCATION_ID,
    bindingDigest: DIGEST_A,
    // T33：初始压缩材料身份是冻结 Start 语义的显式字段，未选择时必须是 null
    // （不能省略——省略与 null 是同一个语义，但契约要求显式表达，不设旧/新 decoder 双轨）。
    initialCompression: null,
    principal: { type: "user" as const, id: "user-1", source: "authenticated_user" as const },
    runtimeRevisionId: RUNTIME_REVISION_ID,
    policy: { revisionId: POLICY_REF, digest: DIGEST_A },
    workspace: { bindingId: WORKSPACE_BINDING_ID, contractDigest: DIGEST_A },
    environment: {
      mode: "MANAGED" as const,
      revisionId: ENV_REVISION_ID,
      semanticDigest: DIGEST_A,
    },
    contextSourceDigest: DIGEST_A,
    issuedAt: 1_700_000_000_000,
    expiresAt: 1_700_000_300_000,
    jti: "12121212-1212-4121-8121-121212121212",
  },
  subject: {
    type: "thread" as const,
    threadId: THREAD_ID,
    turnId: TURN_ID,
    triggerItemId: TRIGGER_ITEM_ID,
    triggerItemDigest: DIGEST_B,
  },
};

const validEnvironment = {
  mode: "MANAGED" as const,
  revisionId: ENV_REVISION_ID,
  semanticDigest: DIGEST_A,
};

const validWorkspace = {
  mode: "BOUND" as const,
  bindingId: WORKSPACE_BINDING_ID,
  contractDigest: DIGEST_A,
  continuityMode: "CHECKPOINT_RESTORABLE" as const,
  activationEvidenceRef: "evidence-ref-1",
};

const validLimits = {
  maxEventBytes: MAX_EVENT_BYTES,
  maxBatchEvents: MAX_BATCH_EVENTS,
  maxBatchBytes: MAX_BATCH_BYTES,
  dispatchDeadlineMs: 60_000,
  executionTimeoutMs: 600_000,
};

const validStartRequest = {
  protocolVersion: PROTOCOL_VERSION,
  authority: validAuthority,
  intentType: "start" as const,
  semanticRequestDigest: DIGEST_A,
  executionBinding: validExecutionBinding,
  context: validContext,
  inputs: [{ kind: "inline" as const, digest: DIGEST_B }],
  environment: validEnvironment,
  workspace: validWorkspace,
  activationDigest: DIGEST_A,
  recovery: { kind: "initial" as const },
  producerSequenceStart: "1",
  callbackEndpoints: validCallbackEndpoints,
  credentials: validCredentials,
  executionLimits: validLimits,
};

// ─── Constants ─────────────────────────────────────────────────────────────

describe("RuntimeProtocol constants (§7.1 / §7.3 / §7.11)", () => {
  it("protocolVersion 是整数 3，不是字符串或 v3 别名", () => {
    expect(PROTOCOL_VERSION).toBe(3);
    expect(typeof PROTOCOL_VERSION).toBe("number");
  });

  it("WorkloadToken contractVersion=3 与 formatVersion=1 独立于 protocolVersion", () => {
    expect(CONTRACT_VERSION).toBe(3);
    expect(WORKLOAD_TOKEN_FORMAT_VERSION).toBe(1);
  });

  it("WorkloadToken 固定 HS256 与域分离前缀，audiences 只两个", () => {
    expect(WORKLOAD_TOKEN_ALGORITHM).toBe("HS256");
    expect(WORKLOAD_TOKEN_HMAC_DOMAIN).toBe("snowharness.workload\0");
    expect(WORKLOAD_TOKEN_AUDIENCES).toEqual(["runtime", "gateway"]);
  });

  it("Payload 上限符合协议：单事件 256KiB、批次 100 条 1MiB", () => {
    expect(MAX_EVENT_BYTES).toBe(262_144);
    expect(MAX_BATCH_EVENTS).toBe(100);
    expect(MAX_BATCH_BYTES).toBe(1_048_576);
  });

  it("issuedAt 未来时钟容差 5 秒（不用于 Lease 判定）", () => {
    expect(MAX_ISSUED_AT_FUTURE_SKEW_MS).toBe(5_000);
  });

  it("Transport retry 序列 1/2/4/8/16/30 秒 + 20% 抖动 + 3s/15s 超时", () => {
    expect(TRANSPORT_RETRY_BACKOFF_MS).toEqual([1_000, 2_000, 4_000, 8_000, 16_000, 30_000]);
    expect(TRANSPORT_RETRY_JITTER_RATIO).toBe(0.2);
    expect(TRANSPORT_CONNECT_TIMEOUT_MS).toBe(3_000);
    expect(TRANSPORT_REQUEST_TIMEOUT_MS).toBe(15_000);
    expect(RECOVERY_RETRY_MAX_BACKOFF_MS).toBe(30_000);
  });
});

// ─── Primitive schemas ─────────────────────────────────────────────────────

describe("Primitive schemas", () => {
  it("uuidSchema 接受合法 UUID 拒绝非法形式", () => {
    expect(uuidSchema.safeParse(INVOCATION_ID).success).toBe(true);
    expect(uuidSchema.safeParse("not-a-uuid").success).toBe(false);
    expect(uuidSchema.safeParse("").success).toBe(false);
  });

  it("decimalStringSchema 接受非负十进制字符串拒绝前导零/负号/浮点", () => {
    expect(decimalStringSchema.safeParse("0").success).toBe(true);
    expect(decimalStringSchema.safeParse("12345").success).toBe(true);
    expect(decimalStringSchema.safeParse("01").success).toBe(false);
    expect(decimalStringSchema.safeParse("-1").success).toBe(false);
    expect(decimalStringSchema.safeParse("1.5").success).toBe(false);
    expect(decimalStringSchema.safeParse(123).success).toBe(false);
  });

  it("positiveDecimalStringSchema 拒绝 0", () => {
    expect(positiveDecimalStringSchema.safeParse("0").success).toBe(false);
    expect(positiveDecimalStringSchema.safeParse("1").success).toBe(true);
  });

  it("sha256DigestSchema 强制 sha256:<64 lowercase hex>", () => {
    expect(sha256DigestSchema.safeParse(DIGEST_A).success).toBe(true);
    expect(sha256DigestSchema.safeParse(`sha256:${"A".repeat(64)}`).success).toBe(false);
    expect(sha256DigestSchema.safeParse(`sha512:${"a".repeat(128)}`).success).toBe(false);
    expect(sha256DigestSchema.safeParse("a".repeat(64)).success).toBe(false);
  });

  it("unixMillisSchema 拒绝负数、浮点、超安全整数", () => {
    expect(unixMillisSchema.safeParse(0).success).toBe(true);
    expect(unixMillisSchema.safeParse(1_800_000_000_000).success).toBe(true);
    expect(unixMillisSchema.safeParse(-1).success).toBe(false);
    expect(unixMillisSchema.safeParse(1.5).success).toBe(false);
    expect(unixMillisSchema.safeParse(Number.MAX_SAFE_INTEGER + 1).success).toBe(false);
  });
});

// ─── AuthorityIdentity ─────────────────────────────────────────────────────

describe("AuthorityIdentity (§7.2)", () => {
  it("接受完整 6 元组", () => {
    expect(AuthorityIdentitySchema.safeParse(validAuthority).success).toBe(true);
  });

  it("拒绝缺字段与未声明字段（strict）", () => {
    const { sessionBindingId: _omit, ...partial } = validAuthority;
    void _omit;
    expect(AuthorityIdentitySchema.safeParse(partial).success).toBe(false);
    expect(
      AuthorityIdentitySchema.safeParse({ ...validAuthority, tenantId: TENANT_ID }).success,
    ).toBe(false);
  });

  it("leaseEpoch 必须正整数十进制字符串", () => {
    expect(AuthorityIdentitySchema.safeParse({ ...validAuthority, leaseEpoch: "0" }).success).toBe(
      false,
    );
    expect(AuthorityIdentitySchema.safeParse({ ...validAuthority, leaseEpoch: 7 }).success).toBe(
      false,
    );
    expect(AuthorityIdentitySchema.safeParse({ ...validAuthority, leaseEpoch: "-1" }).success).toBe(
      false,
    );
  });
});

// ─── Credentials ───────────────────────────────────────────────────────────

describe("Credentials envelope (§7.3)", () => {
  it("接受 runtimeToken/gatewayToken/expiresAt 三元", () => {
    expect(CredentialsSchema.safeParse(validCredentials).success).toBe(true);
  });

  it("拒绝旧 GatewayAccess.access_token 混杂命名", () => {
    expect(
      CredentialsSchema.safeParse({
        access_token: "x",
        gateway_access: "y",
        expiresAt: 1,
      }).success,
    ).toBe(false);
  });

  it("拒绝空 Token 字符串", () => {
    expect(CredentialsSchema.safeParse({ ...validCredentials, runtimeToken: "" }).success).toBe(
      false,
    );
  });
});

// ─── Capabilities ──────────────────────────────────────────────────────────

describe("RuntimeCapabilities (§7.4)", () => {
  const validCapabilities = {
    protocolVersion: PROTOCOL_VERSION,
    contractDigest: DIGEST_A,
    runtimeTargetDigest: DIGEST_B,
    features: {
      heartbeat: true,
      durableStartIdempotency: true,
      startedEvent: true,
      exactReplay: true,
      cancel: true,
      resume: true,
      steer: true,
      subjectTypes: ["thread", "job"],
      workspaceModes: ["CHECKPOINT_RESTORABLE"],
      filesystemSemantics: {
        kind: "posix",
        caseSensitive: true,
        symlinks: true,
        permissions: true,
        hardlinks: true,
        specialFiles: false,
        xattrsAcl: false,
        mtime: "ns",
      },
    },
    limits: {
      maxEventBytes: MAX_EVENT_BYTES,
      maxBatchEvents: MAX_BATCH_EVENTS,
      maxBatchBytes: MAX_BATCH_BYTES,
    },
  };

  it("接受完整能力声明", () => {
    expect(RuntimeCapabilitiesSchema.safeParse(validCapabilities).success).toBe(true);
  });

  it("拒绝 protocolVersion != 3", () => {
    expect(
      RuntimeCapabilitiesSchema.safeParse({ ...validCapabilities, protocolVersion: 2 }).success,
    ).toBe(false);
    expect(
      RuntimeCapabilitiesSchema.safeParse({ ...validCapabilities, protocolVersion: "3" }).success,
    ).toBe(false);
  });

  it("拒绝 heartbeat=false 等协议必需能力缺失", () => {
    const bad = {
      ...validCapabilities,
      features: { ...validCapabilities.features, heartbeat: false },
    };
    expect(RuntimeCapabilitiesSchema.safeParse(bad).success).toBe(false);
  });

  it("拒绝超限 limits（不得超过协议上限）", () => {
    const bad = {
      ...validCapabilities,
      limits: { ...validCapabilities.limits, maxEventBytes: MAX_EVENT_BYTES + 1 },
    };
    expect(RuntimeCapabilitiesSchema.safeParse(bad).success).toBe(false);
  });

  it("拒绝空 subjectTypes（至少一种）", () => {
    const bad = {
      ...validCapabilities,
      features: { ...validCapabilities.features, subjectTypes: [] },
    };
    expect(RuntimeCapabilitiesSchema.safeParse(bad).success).toBe(false);
  });
});

describe("SubjectType / WorkspaceMode 枚举", () => {
  it("SubjectType 只 thread/job", () => {
    expect(SubjectTypeSchema.safeParse("thread").success).toBe(true);
    expect(SubjectTypeSchema.safeParse("job").success).toBe(true);
    expect(SubjectTypeSchema.safeParse("service").success).toBe(false);
  });

  it("WorkspaceMode 4 个正式业务模式（不是版本模式）", () => {
    for (const mode of [
      "HOST_AFFINE",
      "SHARED_DURABLE",
      "CHECKPOINT_RESTORABLE",
      "NO_PLATFORM_WORKSPACE",
    ]) {
      expect(WorkspaceModeSchema.safeParse(mode).success).toBe(true);
    }
    expect(WorkspaceModeSchema.safeParse("V2_MODE").success).toBe(false);
    expect(WorkspaceModeSchema.safeParse("LEGACY_HOST").success).toBe(false);
  });
});

// ─── RuntimeStartRequest ───────────────────────────────────────────────────

describe("RuntimeStartRequest (§7.5)", () => {
  it("接受完整合法请求", () => {
    expect(RuntimeStartRequestSchema.safeParse(validStartRequest).success).toBe(true);
  });

  it("拒绝 protocolVersion != 3", () => {
    expect(
      RuntimeStartRequestSchema.safeParse({ ...validStartRequest, protocolVersion: 2 }).success,
    ).toBe(false);
  });

  it("拒绝未声明字段（strict）", () => {
    expect(
      RuntimeStartRequestSchema.safeParse({ ...validStartRequest, unexpected: 1 }).success,
    ).toBe(false);
  });

  it("拒绝缺 credentials", () => {
    const { credentials: _omit, ...noCreds } = validStartRequest;
    void _omit;
    expect(RuntimeStartRequestSchema.safeParse(noCreds).success).toBe(false);
  });

  it("traceContext 可选", () => {
    expect(
      RuntimeStartRequestSchema.safeParse({
        ...validStartRequest,
        traceContext: { traceId: "trace-1" },
      }).success,
    ).toBe(true);
  });

  it("intentType 只 start/resume", () => {
    expect(IntentTypeSchema.safeParse("start").success).toBe(true);
    expect(IntentTypeSchema.safeParse("resume").success).toBe(true);
    expect(IntentTypeSchema.safeParse("restart").success).toBe(false);
  });

  it("producerSequenceStart 必须正整数字符串（恢复不能从 1 重置的语义由服务端校验）", () => {
    expect(
      RuntimeStartRequestSchema.safeParse({ ...validStartRequest, producerSequenceStart: "0" })
        .success,
    ).toBe(false);
  });
});

describe("RuntimeStartRequest 子结构 discriminated unions", () => {
  it("Environment MANAGED 必须带 revisionId + semanticDigest", () => {
    expect(EnvironmentSchema.safeParse(validEnvironment).success).toBe(true);
    expect(
      EnvironmentSchema.safeParse({ mode: "MANAGED", revisionId: ENV_REVISION_ID }).success,
    ).toBe(false);
    expect(EnvironmentSchema.safeParse({ mode: "NO_PLATFORM_ENVIRONMENT" }).success).toBe(true);
  });

  it("Workspace BOUND 必须带 binding/contract/continuity/activation", () => {
    expect(WorkspaceModeSchema.safeParse(validWorkspace.continuityMode).success).toBe(true);
  });

  it("ContextHandle subject.type=thread/job 判别", () => {
    expect(ContextHandleSchema.safeParse(validContext).success).toBe(true);
    const jobContext = {
      common: validContext.common,
      subject: {
        type: "job",
        jobId: INVOCATION_ID,
        inputKind: "inline",
        inputHash: DIGEST_A,
        triggerRef: "scheduler:daily",
      },
    };
    expect(ContextHandleSchema.safeParse(jobContext).success).toBe(true);
    // 混合 subject 字段应被拒绝
    const mixed = {
      common: validContext.common,
      subject: { type: "thread", threadId: THREAD_ID },
    };
    expect(ContextHandleSchema.safeParse(mixed).success).toBe(false);
  });

  it("ExecutionBinding 拒绝未声明字段", () => {
    expect(ExecutionBindingSchema.safeParse(validExecutionBinding).success).toBe(true);
    expect(
      ExecutionBindingSchema.safeParse({ ...validExecutionBinding, initialEnvironmentLeaseId: "x" })
        .success,
    ).toBe(false);
  });

  it("ExecutionLimits 拒绝超过协议上限", () => {
    expect(ExecutionLimitsSchema.safeParse(validLimits).success).toBe(true);
    expect(
      ExecutionLimitsSchema.safeParse({ ...validLimits, maxBatchEvents: MAX_BATCH_EVENTS + 1 })
        .success,
    ).toBe(false);
  });

  it("CallbackEndpoints 拒绝非 URL", () => {
    expect(CallbackEndpointsSchema.safeParse(validCallbackEndpoints).success).toBe(true);
    expect(
      CallbackEndpointsSchema.safeParse({ ...validCallbackEndpoints, events: "not-a-url" }).success,
    ).toBe(false);
  });
});

// ─── RuntimeStartResponse ──────────────────────────────────────────────────

describe("RuntimeStartResponse (§7.5)", () => {
  it("accepted 必须字面 true（HTTP 202 才走此 schema）", () => {
    const response = {
      protocolVersion: PROTOCOL_VERSION,
      authority: validAuthority,
      semanticRequestDigest: DIGEST_A,
      accepted: true,
      remoteSessionRef: "remote-session-1",
      remoteExecutionRef: "remote-exec-1",
      capabilitiesDigest: DIGEST_B,
      acceptedAt: 1_800_000_000_000,
    };
    expect(RuntimeStartResponseSchema.safeParse(response).success).toBe(true);
    expect(RuntimeStartResponseSchema.safeParse({ ...response, accepted: false }).success).toBe(
      false,
    );
  });
});

// ─── Heartbeat ─────────────────────────────────────────────────────────────

describe("HeartbeatRequest (§7.6)", () => {
  it("接受完整合法 heartbeat", () => {
    const request = {
      protocolVersion: PROTOCOL_VERSION,
      authority: validAuthority,
      heartbeatId: EVENT_ID,
      runtimeState: "running",
      lastObservedProducerSequence: "42",
      requestCredentialRefresh: false,
    };
    expect(HeartbeatRequestSchema.safeParse(request).success).toBe(true);
  });

  it("拒绝未知 runtimeState", () => {
    const request = {
      protocolVersion: PROTOCOL_VERSION,
      authority: validAuthority,
      heartbeatId: EVENT_ID,
      runtimeState: "suspended",
      lastObservedProducerSequence: "42",
      requestCredentialRefresh: false,
    };
    expect(HeartbeatRequestSchema.safeParse(request).success).toBe(false);
  });
});

// ─── Event Batch ───────────────────────────────────────────────────────────

describe("RuntimeEventBatch (§7.7)", () => {
  const validEvent = {
    eventId: EVENT_ID,
    producerSequence: "1",
    type: "execution.started" as const,
    schemaVersion: 1,
    payload: { intentKey: "start:ownership-1" },
  };

  it("接受合法批次", () => {
    const batch = {
      protocolVersion: PROTOCOL_VERSION,
      authority: validAuthority,
      events: [validEvent],
    };
    expect(RuntimeEventBatchSchema.safeParse(batch).success).toBe(true);
  });

  it("拒绝空批次", () => {
    const batch = {
      protocolVersion: PROTOCOL_VERSION,
      authority: validAuthority,
      events: [],
    };
    expect(RuntimeEventBatchSchema.safeParse(batch).success).toBe(false);
  });

  it("拒绝超过 MAX_BATCH_EVENTS 的批次", () => {
    const events = Array.from({ length: MAX_BATCH_EVENTS + 1 }, () => validEvent);
    const batch = {
      protocolVersion: PROTOCOL_VERSION,
      authority: validAuthority,
      events,
    };
    expect(RuntimeEventBatchSchema.safeParse(batch).success).toBe(false);
  });

  it("event.type 只接受枚举内值", () => {
    expect(RuntimeEventTypeSchema.safeParse("execution.started").success).toBe(true);
    expect(RuntimeEventTypeSchema.safeParse("execution.suspended").success).toBe(true);
    expect(RuntimeEventTypeSchema.safeParse("arbitrary.event").success).toBe(false);
  });

  it("RuntimeEvent 拒绝未声明字段", () => {
    expect(RuntimeEventSchema.safeParse(validEvent).success).toBe(true);
    expect(RuntimeEventSchema.safeParse({ ...validEvent, unexpectedField: 1 }).success).toBe(false);
  });
});

// ─── SafePoint ─────────────────────────────────────────────────────────────

describe("SafePointRequest (§7.10)", () => {
  it("接受完整合法 safe-point 请求", () => {
    const request = {
      protocolVersion: PROTOCOL_VERSION,
      targetAuthority: validAuthority,
      checkpointIntentId: EVENT_ID,
      deadlineMs: 1_800_000_060_000,
      expectedRecoveryAnchorDigest: DIGEST_A,
    };
    expect(SafePointRequestSchema.safeParse(request).success).toBe(true);
  });
});

// ─── Error codes ───────────────────────────────────────────────────────────

describe("RuntimeErrorCode (§7.11 / §四十二)", () => {
  it("包含全部领域语义错码", () => {
    const required = [
      "NotCurrentExecutor",
      "OwnershipExpired",
      "HealthyOwnerExists",
      "AttemptMismatch",
      "RuntimeSessionMismatch",
      "EventPayloadConflict",
      "ProducerSequenceGap",
      "StartIntentConflict",
      "EnvironmentRevisionMismatch",
      "EnvironmentComplianceFailed",
      "WorkspaceNotReady",
      "WorkspaceWriterNotFenced",
      "CheckpointStale",
      "CheckpointIntegrityFailed",
      "EffectUnresolved",
      "ProtocolVersionUnsupported",
      "InputDigestMismatch",
    ];
    for (const code of required) {
      expect(RuntimeErrorCodeSchema.safeParse(code).success).toBe(true);
    }
  });

  it("拒绝开发阶段错码别名", () => {
    expect(RuntimeErrorCodeSchema.safeParse("V3AuthError").success).toBe(false);
    expect(RuntimeErrorCodeSchema.safeParse("NewRuntimeError").success).toBe(false);
    expect(RuntimeErrorCodeSchema.safeParse("LegacyRejected").success).toBe(false);
  });
});

// ─── JCS canonicalization (RFC 8785) ───────────────────────────────────────

describe("canonicalizeJson (RFC 8785)", () => {
  it("空对象/数组", () => {
    expect(canonicalizeJson({})).toBe("{}");
    expect(canonicalizeJson([])).toBe("[]");
  });

  it("null / boolean / number", () => {
    expect(canonicalizeJson(null)).toBe("null");
    expect(canonicalizeJson(true)).toBe("true");
    expect(canonicalizeJson(false)).toBe("false");
    expect(canonicalizeJson(0)).toBe("0");
    expect(canonicalizeJson(-0)).toBe("0");
    expect(canonicalizeJson(1)).toBe("1");
    expect(canonicalizeJson(-1.5)).toBe("-1.5");
    expect(canonicalizeJson(1e30)).toBe("1e+30");
  });

  it("对象 key 按 UTF-16 code unit 排序（不论插入顺序）", () => {
    expect(canonicalizeJson({ b: 1, a: 2, c: 3 })).toBe('{"a":2,"b":1,"c":3}');
    // U+007F (DEL) 不在 RFC 8785 §3.2.2 强制转义范围（只 U+0000..U+001F），
    // 因此作为 key 时以原字符输出；U+0000 必须 \\u0000 转义。
    expect(canonicalizeJson({ "\u007f": 1, "\u0000": 2 })).toBe('{"\\u0000":2,"\u007f":1}');
    // 大写字母 code unit 小于小写
    expect(canonicalizeJson({ b: 1, A: 2, a: 3, B: 4 })).toBe('{"A":2,"B":4,"a":3,"b":1}');
  });

  it("嵌套对象递归排序", () => {
    expect(canonicalizeJson({ outer: { b: 1, a: 2 } })).toBe('{"outer":{"a":2,"b":1}}');
  });

  it("数组保留顺序", () => {
    expect(canonicalizeJson([3, 1, 2])).toBe("[3,1,2]");
    expect(canonicalizeJson([{ b: 1, a: 2 }])).toBe('[{"a":2,"b":1}]');
  });

  it("字符串转义：仅 quote/backslash/控制字符", () => {
    expect(canonicalizeJson("plain")).toBe('"plain"');
    expect(canonicalizeJson('with"quote')).toBe('"with\\"quote"');
    expect(canonicalizeJson("with\\backslash")).toBe('"with\\\\backslash"');
    expect(canonicalizeJson("\b\t\n\f\r")).toBe('"\\b\\t\\n\\f\\r"');
    expect(canonicalizeJson("\u0000\u001f")).toBe('"\\u0000\\u001f"');
    // U+2028/U+2029 不转义（RFC 8785 与 JSON.stringify 差异点）
    expect(canonicalizeJson("\u2028\u2029")).toBe('"\u2028\u2029"');
  });

  it("undefined 属性被剔除", () => {
    expect(canonicalizeJson({ a: 1, b: undefined, c: 3 })).toBe('{"a":1,"c":3}');
  });

  it("拒绝非有限数值", () => {
    expect(() => canonicalizeJson(Number.NaN)).toThrow(/non-finite/);
    expect(() => canonicalizeJson(Number.POSITIVE_INFINITY)).toThrow(/non-finite/);
    expect(() => canonicalizeJson(Number.NEGATIVE_INFINITY)).toThrow(/non-finite/);
  });

  it("拒绝 undefined / function / symbol / bigint 顶层", () => {
    expect(() => canonicalizeJson(undefined)).toThrow(/undefined/);
    expect(() => canonicalizeJson(() => 1)).toThrow(/function/);
    expect(() => canonicalizeJson(Symbol("x"))).toThrow(/symbol/);
    expect(() => canonicalizeJson(BigInt(1))).toThrow(/bigint/);
  });

  it("拒绝数组内 undefined", () => {
    expect(() => canonicalizeJson([1, undefined, 3])).toThrow(/undefined inside array/);
  });

  it("拒绝循环引用", () => {
    const obj: Record<string, unknown> = { a: 1 };
    obj.self = obj;
    expect(() => canonicalizeJson(obj)).toThrow(/circular/);
    const arr: unknown[] = [1];
    arr.push(arr);
    expect(() => canonicalizeJson(arr)).toThrow(/circular/);
  });

  it("拒绝 lone surrogate", () => {
    expect(() => canonicalizeJson("\uD800")).toThrow(/lone high surrogate/);
    expect(() => canonicalizeJson("\uDC00")).toThrow(/lone low surrogate/);
  });

  it("接受合法代理对", () => {
    expect(canonicalizeJson("\uD83D\uDE00")).toBe('"\uD83D\uDE00"');
  });
});

// ─── protocolDigest ────────────────────────────────────────────────────────

describe("protocolDigest", () => {
  it("输出 sha256:<64 lowercase hex>", () => {
    const digest = protocolDigest({ a: 1 });
    expect(digest).toMatch(/^sha256:[0-9a-f]{64}$/);
  });

  it("key 顺序无关（JCS 保证）", () => {
    expect(protocolDigest({ a: 1, b: 2 })).toBe(protocolDigest({ b: 2, a: 1 }));
  });

  it("嵌套 key 顺序无关", () => {
    expect(protocolDigest({ outer: { a: 1, b: 2 } })).toBe(
      protocolDigest({ outer: { b: 2, a: 1 } }),
    );
  });

  it("值变化 → digest 变化", () => {
    expect(protocolDigest({ a: 1 })).not.toBe(protocolDigest({ a: 2 }));
  });

  it("数字表示无关（同一 Number 相同 digest）", () => {
    expect(protocolDigest({ a: 1.0 })).toBe(protocolDigest({ a: 1 }));
  });
});

// ─── Start digest exclusion domains ────────────────────────────────────────

describe("Start digest exclusion domains (§7.1)", () => {
  it("excluded 顶层字段固定 3 项：credentials / traceContext / callbackEndpoints", () => {
    expect([...START_DIGEST_EXCLUDED_FIELDS].sort()).toEqual(
      ["callbackEndpoints", "credentials", "traceContext"].sort(),
    );
  });

  it("buildStartSemanticDigestInput 剔除三个排除字段", () => {
    const parsed = RuntimeStartRequestSchema.parse(validStartRequest);
    const semantic = buildStartSemanticDigestInput(parsed);
    expect(semantic).not.toHaveProperty("credentials");
    expect(semantic).not.toHaveProperty("traceContext");
    expect(semantic).not.toHaveProperty("callbackEndpoints");
    expect(semantic).not.toHaveProperty("semanticRequestDigest");
    // 稳定资源身份仍保留
    expect(semantic).toHaveProperty("authority");
    expect(semantic).toHaveProperty("executionBinding");
    expect(semantic).toHaveProperty("context");
    expect(semantic).toHaveProperty("producerSequenceStart");
  });

  it("credentials 值变化不影响 semanticRequestDigest", () => {
    const parsed = RuntimeStartRequestSchema.parse(validStartRequest);
    const digestA = computeSemanticRequestDigest(parsed);
    const mutated = RuntimeStartRequestSchema.parse({
      ...validStartRequest,
      credentials: { ...validCredentials, runtimeToken: "different.token.value" },
    });
    const digestB = computeSemanticRequestDigest(mutated);
    expect(digestA).toBe(digestB);
  });

  it("callbackEndpoints URL 变化不影响 semanticRequestDigest（可续期 URL 排除域）", () => {
    const parsed = RuntimeStartRequestSchema.parse(validStartRequest);
    const digestA = computeSemanticRequestDigest(parsed);
    const mutated = RuntimeStartRequestSchema.parse({
      ...validStartRequest,
      callbackEndpoints: {
        ...validCallbackEndpoints,
        events: "https://platform.example/runtime/invocations/x/events?sig=rotated",
      },
    });
    const digestB = computeSemanticRequestDigest(mutated);
    expect(digestA).toBe(digestB);
  });

  it("traceContext 变化不影响 semanticRequestDigest", () => {
    const base = RuntimeStartRequestSchema.parse(validStartRequest);
    const digestA = computeSemanticRequestDigest(base);
    const withTrace = RuntimeStartRequestSchema.parse({
      ...validStartRequest,
      traceContext: { traceId: "trace-xyz" },
    });
    const digestB = computeSemanticRequestDigest(withTrace);
    expect(digestA).toBe(digestB);
  });

  it("ContextHandle 签名时间/jti 轮换不影响 semanticRequestDigest（业务内容不变）", () => {
    const base = RuntimeStartRequestSchema.parse(validStartRequest);
    const digestA = computeSemanticRequestDigest(base);
    // R02 §1：可轮换的只有 issuedAt / expiresAt / jti 这类签名时间材料。
    const rotated = RuntimeStartRequestSchema.parse({
      ...validStartRequest,
      context: {
        ...validContext,
        common: {
          ...validContext.common,
          issuedAt: validContext.common.issuedAt + 60_000,
          expiresAt: validContext.common.expiresAt + 60_000,
          jti: TENANT_ID,
        },
      },
    });
    expect(computeSemanticRequestDigest(rotated)).toBe(digestA);
    // 业务内容（ContextHandle 的稳定事实）一起变则必须被发现。
    const businessChanged = RuntimeStartRequestSchema.parse({
      ...validStartRequest,
      context: {
        ...validContext,
        common: { ...validContext.common, contextSourceDigest: DIGEST_B },
      },
    });
    expect(computeSemanticRequestDigest(businessChanged)).not.toBe(digestA);
  });

  it("稳定资源身份变化必须改变 semanticRequestDigest（invocationId / threadId / producerSequenceStart）", () => {
    const base = RuntimeStartRequestSchema.parse(validStartRequest);
    const digestA = computeSemanticRequestDigest(base);

    const differentInvocation = RuntimeStartRequestSchema.parse({
      ...validStartRequest,
      authority: { ...validAuthority, invocationId: TENANT_ID },
    });
    expect(computeSemanticRequestDigest(differentInvocation)).not.toBe(digestA);

    const differentThread = RuntimeStartRequestSchema.parse({
      ...validStartRequest,
      context: {
        ...validContext,
        subject: { ...validContext.subject, threadId: TENANT_ID },
      },
    });
    expect(computeSemanticRequestDigest(differentThread)).not.toBe(digestA);

    const differentProducer = RuntimeStartRequestSchema.parse({
      ...validStartRequest,
      producerSequenceStart: "99",
    });
    expect(computeSemanticRequestDigest(differentProducer)).not.toBe(digestA);
  });
});

// ─── Event payload hash ────────────────────────────────────────────────────

describe("computeEventPayloadHash (§7.1)", () => {
  const event = {
    eventId: EVENT_ID,
    producerSequence: "5" as const,
    type: "execution.started" as const,
    schemaVersion: 1,
    payload: { intentKey: "start:1" },
  };

  it("覆盖 type / schemaVersion / payload", () => {
    const hash = computeEventPayloadHash(event);
    expect(hash).toMatch(/^sha256:[0-9a-f]{64}$/);
  });

  it("eventId / producerSequence 变化不影响 payloadHash（另作严格匹配）", () => {
    const hashA = computeEventPayloadHash(event);
    const hashB = computeEventPayloadHash({
      ...event,
      eventId: INGRESS_ID,
      producerSequence: "6",
    });
    expect(hashA).toBe(hashB);
  });

  it("payload / type / schemaVersion 变化改变 payloadHash", () => {
    const hashA = computeEventPayloadHash(event);
    expect(computeEventPayloadHash({ ...event, payload: { intentKey: "start:2" } })).not.toBe(
      hashA,
    );
    expect(computeEventPayloadHash({ ...event, type: "execution.completed" as const })).not.toBe(
      hashA,
    );
    expect(computeEventPayloadHash({ ...event, schemaVersion: 2 })).not.toBe(hashA);
  });
});

// ─── Capabilities contract digest ─────────────────────────────────────────

describe("computeCapabilitiesContractDigest (§7.1)", () => {
  const capabilities = {
    protocolVersion: PROTOCOL_VERSION,
    contractDigest: DIGEST_A,
    runtimeTargetDigest: DIGEST_B,
    features: {
      heartbeat: true as const,
      durableStartIdempotency: true as const,
      startedEvent: true as const,
      exactReplay: true as const,
      cancel: true as const,
      resume: true as const,
      steer: true as const,
      subjectTypes: ["thread", "job"] as ("thread" | "job")[],
      workspaceModes: ["HOST_AFFINE"] as "HOST_AFFINE"[],
      filesystemSemantics: {
        kind: "posix",
        caseSensitive: true,
        symlinks: true,
        permissions: true,
        hardlinks: true,
        specialFiles: false,
        xattrsAcl: false,
        mtime: "ns",
      },
    },
    limits: {
      maxEventBytes: MAX_EVENT_BYTES,
      maxBatchEvents: MAX_BATCH_EVENTS,
      maxBatchBytes: MAX_BATCH_BYTES,
    },
  };

  it("覆盖 protocolVersion / features / limits", () => {
    const parsed = RuntimeCapabilitiesSchema.parse(capabilities);
    const digest = computeCapabilitiesContractDigest(parsed);
    expect(digest).toMatch(/^sha256:[0-9a-f]{64}$/);
  });

  it("runtimeTargetDigest 不进入 contractDigest（独立字段）", () => {
    const parsed = RuntimeCapabilitiesSchema.parse(capabilities);
    const digestA = computeCapabilitiesContractDigest(parsed);
    const mutated = RuntimeCapabilitiesSchema.parse({
      ...capabilities,
      runtimeTargetDigest: DIGEST_A,
    });
    const digestB = computeCapabilitiesContractDigest(mutated);
    expect(digestA).toBe(digestB);
  });
});

// ─── Idempotency keys ──────────────────────────────────────────────────────

describe("Idempotency keys (§7.5 / §7.8)", () => {
  it("start:{ownershipId} 不含 JTI，不随网络重试变化", () => {
    expect(buildStartIdempotencyKey(OWNERSHIP_ID)).toBe(`start:${OWNERSHIP_ID}`);
  });

  it("command:{commandId}", () => {
    expect(buildCommandIdempotencyKey(EVENT_ID)).toBe(`command:${EVENT_ID}`);
  });
});
