/**
 * V11 EffectRecord + EffectTarget 集成测试（阶段 8 S08-C05）。
 *
 * 事实源：
 * - ../v11-agentkit-platform/10-core-data-model.md §6.7、§6.6、§5.5。
 * - ../v11-agentkit-platform/09-unified-domain-model.md §10（unknown_effect 不自动重放）。
 * - ../v11-agentkit-platform/11-api-and-event-boundaries.md §5.2（Gateway 即时核对）、§6.5（Admin 长期核对）。
 * - ../v11-agentkit-platform-development-plan/08-workspace-desktop-tool-execution-and-effects.md S08-W05。
 *
 * 覆盖：
 * - 辅助函数：isEffectType / isEffectState / isEffectTargetState / isVerificationMethod /
 *   isValidTargetHash / computeTargetHash / deriveEffectStateFromTargets（5 种状态派生）。
 * - createEffectRecord：成功 + 默认 not_started + 一对一约束 + 校验错误。
 * - createEffectTargets：批量 + 自动计算 hash + UNIQUE 重复 + 校验错误。
 * - 查询：byId / byToolCall / listEffectTargets / listEffectRecordsByInvocation /
 *   listEffectRecordsByState + 跨租户隔离。
 * - reconcileEffect：
 *   · Gateway 路径：provider_query 成功 confirmed_success → call_state=succeeded
 *   · Gateway 路径：operation_id 不匹配 → EffectOperationMismatchError
 *   · Gateway 路径：manual_evidence → EffectVerificationMethodNotAllowedError
 *   · Admin 路径：manual_evidence 成功 confirmed_failure → call_state=failed
 *   · Admin 路径：confirmed_partial → call_state=succeeded
 *   · unknown_effect 保持 → call_state 保持 unknown_effect
 *   · 多次 reconcile 直到所有 target 确认
 *   · 终态再 reconcile → EffectAlreadyConfirmedError
 *   · targetHash 不存在 → EffectTargetNotFoundError
 *   · 跨租户 → EffectNotFoundError
 * - markToolCallUnknownEffect：创建 EffectRecord + 迁移 ToolCall 到 unknown_effect。
 */
import { randomUUID } from "node:crypto";
import { db } from "@/lib/db/client";
import { resetDatabase } from "@/lib/db/test/mysql-harness";
import {
  EffectAlreadyConfirmedError,
  EffectNotFoundError,
  EffectOperationMismatchError,
  EffectTargetNotFoundError,
  EffectValidationError,
  EffectVerificationMethodNotAllowedError,
  computeTargetHash,
  createEffectRecord,
  createEffectTargets,
  deriveEffectStateFromTargets,
  getEffectRecordById,
  getEffectRecordByToolCall,
  isEffectState,
  isEffectTargetState,
  isEffectType,
  isValidTargetHash,
  isVerificationMethod,
  listEffectRecordsByInvocation,
  listEffectRecordsByState,
  listEffectTargets,
  markToolCallUnknownEffect,
  reconcileEffect,
} from "@/lib/v11/capability/effect-queries";
import {
  type V11ToolCall,
  computeArgumentsHash,
  createToolCall,
  getToolCallById,
  updateToolCallState,
} from "@/lib/v11/capability/tool-call-queries";
import { ensureDefaultTenant } from "@/lib/identity/tenant-queries";
import { EFFECT_TERMINAL_STATES, type EffectTargetState } from "@/lib/v11/schema/effect";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

beforeEach(async () => {
  await resetDatabase(db);
});

afterEach(() => {
  // 无外部状态污染
});

// ─── 辅助：seed 默认租户 + 创建 ToolCall ─────────────────

async function seedTenant() {
  const tenant = await ensureDefaultTenant();
  return tenant.id;
}

/** 创建一个 ToolCall 用于 EffectRecord 测试（不依赖 Tool / SchemaRevision 真实表）。 */
async function seedToolCall(
  tenantId: string,
  options?: {
    operationId?: string;
    initialState?: "proposed" | "running" | "unknown_effect";
  },
): Promise<V11ToolCall> {
  const invocationId = randomUUID();
  const toolCall = await createToolCall({
    tenantId,
    invocationId,
    toolId: randomUUID(),
    toolSchemaRevisionId: randomUUID(),
    schemaHash: "sha256:7d8e2f1a3b4c5d6e7f8a9b0c1d2e3f4a5b6c7d8e9f0a1b2c3d4e5f6a7b8c9d0e",
    operationId: options?.operationId ?? `op-${randomUUID()}`,
    argumentsRedactedJson: { target: "test-target" },
  });
  if (options?.initialState === "running") {
    return updateToolCallState({ tenantId, toolCallId: toolCall.id, toState: "running" });
  }
  if (options?.initialState === "unknown_effect") {
    await updateToolCallState({ tenantId, toolCallId: toolCall.id, toState: "running" });
    return updateToolCallState({ tenantId, toolCallId: toolCall.id, toState: "unknown_effect" });
  }
  return toolCall;
}

/** 构造一个合法的 sha256: hash 用于测试。 */
function buildValidHash(seed: string): string {
  return computeArgumentsHash({ seed });
}

/** 构造单个目标 + 已创建 EffectRecord + 已 running ToolCall。 */
async function seedEffectRecordWithTargets(
  tenantId: string,
  options?: {
    targetRefs?: string[];
    effectType?: "create" | "update" | "delete" | "send" | "payment" | "deploy";
    initialToolCallState?: "proposed" | "running" | "unknown_effect";
    operationId?: string;
  },
) {
  const toolCall = await seedToolCall(tenantId, {
    operationId: options?.operationId,
    initialState: options?.initialToolCallState ?? "running",
  });
  const record = await createEffectRecord({
    tenantId,
    toolCallId: toolCall.id,
    effectType: options?.effectType ?? "send",
    targetSummaryJson: { total: options?.targetRefs?.length ?? 2, description: "群发邮件" },
    externalIdempotencyKey: `idk-${randomUUID()}`,
    initialEffectState:
      options?.initialToolCallState === "unknown_effect" ? "unknown_effect" : null,
  });
  const targetRefs = options?.targetRefs ?? [
    "user:email:foo@example.com",
    "user:email:bar@example.com",
  ];
  const targets = await createEffectTargets({
    tenantId,
    effectRecordId: record.id,
    targets: targetRefs.map((ref) => ({ targetRef: ref })),
  });
  return { toolCall, record, targets };
}

// ═══════════════════════════════════════════════════════════
// 1. 辅助函数校验
// ═══════════════════════════════════════════════════════════

describe("V11 effect-queries：辅助函数校验", () => {
  it("isEffectType：合法/非法判断", () => {
    expect(isEffectType("create")).toBe(true);
    expect(isEffectType("update")).toBe(true);
    expect(isEffectType("delete")).toBe(true);
    expect(isEffectType("send")).toBe(true);
    expect(isEffectType("payment")).toBe(true);
    expect(isEffectType("deploy")).toBe(true);
    expect(isEffectType("rollback")).toBe(false);
    expect(isEffectType("")).toBe(false);
  });

  it("isEffectState：合法/非法判断", () => {
    expect(isEffectState("not_started")).toBe(true);
    expect(isEffectState("confirmed_success")).toBe(true);
    expect(isEffectState("confirmed_partial")).toBe(true);
    expect(isEffectState("confirmed_failure")).toBe(true);
    expect(isEffectState("unknown_effect")).toBe(true);
    expect(isEffectState("reverted")).toBe(false);
  });

  it("isEffectTargetState：合法/非法判断", () => {
    expect(isEffectTargetState("confirmed_success")).toBe(true);
    expect(isEffectTargetState("confirmed_failure")).toBe(true);
    expect(isEffectTargetState("unknown")).toBe(true);
    expect(isEffectTargetState("pending")).toBe(false);
  });

  it("isVerificationMethod：合法/非法判断", () => {
    expect(isVerificationMethod("provider_query")).toBe(true);
    expect(isVerificationMethod("callback_evidence")).toBe(true);
    expect(isVerificationMethod("manual_evidence")).toBe(true);
    expect(isVerificationMethod("auto_check")).toBe(false);
  });

  it("isValidTargetHash：sha256: 前缀 + 64 hex", () => {
    expect(
      isValidTargetHash("sha256:7d8e2f1a3b4c5d6e7f8a9b0c1d2e3f4a5b6c7d8e9f0a1b2c3d4e5f6a7b8c9d0e"),
    ).toBe(true);
    expect(isValidTargetHash("sha256:abc")).toBe(false);
    expect(isValidTargetHash("md5:7d8e2f1a3b4c5d6e7f8a9b0c1d2e3f4a")).toBe(false);
    expect(isValidTargetHash("")).toBe(false);
  });

  it("computeTargetHash：返回 sha256: 前缀 + 64 hex", () => {
    const hash = computeTargetHash("user:email:foo@example.com");
    expect(hash.startsWith("sha256:")).toBe(true);
    expect(hash.slice("sha256:".length)).toMatch(/^[0-9a-f]{64}$/);
  });

  it("computeTargetHash：相同输入产生相同 hash", () => {
    expect(computeTargetHash("abc")).toBe(computeTargetHash("abc"));
  });

  it("computeTargetHash：不同输入产生不同 hash", () => {
    expect(computeTargetHash("abc")).not.toBe(computeTargetHash("abd"));
  });

  it("computeTargetHash：空字符串 → ValidationError", () => {
    expect(() => computeTargetHash("")).toThrow(EffectValidationError);
    expect(() => computeTargetHash("")).toThrow("targetRef 不能为空");
  });

  it("deriveEffectStateFromTargets：空数组 → unknown_effect", () => {
    expect(deriveEffectStateFromTargets([])).toBe("unknown_effect");
  });

  it("deriveEffectStateFromTargets：全部 success → confirmed_success", () => {
    const targets: EffectTargetState[] = [
      "confirmed_success",
      "confirmed_success",
      "confirmed_success",
    ];
    expect(deriveEffectStateFromTargets(targets)).toBe("confirmed_success");
  });

  it("deriveEffectStateFromTargets：全部 failure → confirmed_failure", () => {
    const targets: EffectTargetState[] = ["confirmed_failure", "confirmed_failure"];
    expect(deriveEffectStateFromTargets(targets)).toBe("confirmed_failure");
  });

  it("deriveEffectStateFromTargets：success + failure 混合（无 unknown） → confirmed_partial", () => {
    const targets: EffectTargetState[] = [
      "confirmed_success",
      "confirmed_failure",
      "confirmed_success",
    ];
    expect(deriveEffectStateFromTargets(targets)).toBe("confirmed_partial");
  });

  it("deriveEffectStateFromTargets：含任意 unknown → unknown_effect", () => {
    const targets: EffectTargetState[] = ["confirmed_success", "unknown", "confirmed_failure"];
    expect(deriveEffectStateFromTargets(targets)).toBe("unknown_effect");
  });

  it("EFFECT_TERMINAL_STATES：包含 confirmed_success/partial/failure；不包含 unknown_effect", () => {
    expect(EFFECT_TERMINAL_STATES).toContain("confirmed_success");
    expect(EFFECT_TERMINAL_STATES).toContain("confirmed_partial");
    expect(EFFECT_TERMINAL_STATES).toContain("confirmed_failure");
    expect(EFFECT_TERMINAL_STATES).not.toContain("unknown_effect");
    expect(EFFECT_TERMINAL_STATES).not.toContain("not_started");
  });
});

// ═══════════════════════════════════════════════════════════
// 2. createEffectRecord：默认状态 + 一对一 + 校验
// ═══════════════════════════════════════════════════════════

describe("V11 createEffectRecord：默认状态 + 一对一 + 校验", () => {
  it("成功创建 + 默认 not_started + versionNo=1", async () => {
    const tenantId = await seedTenant();
    const toolCall = await seedToolCall(tenantId);

    const record = await createEffectRecord({
      tenantId,
      toolCallId: toolCall.id,
      effectType: "send",
      targetSummaryJson: { total: 86, description: "群发月报" },
      externalIdempotencyKey: "idk-monthly-report-7",
    });

    expect(record.tenantId).toBe(tenantId);
    expect(record.toolCallId).toBe(toolCall.id);
    expect(record.effectType).toBe("send");
    expect(record.effectState).toBe("not_started");
    expect(record.versionNo).toBe(1);
    expect(record.externalIdempotencyKey).toBe("idk-monthly-report-7");
    expect(record.externalResultRef).toBeNull();
    expect(record.verificationMethod).toBeNull();
    expect(record.verifiedAt).toBeNull();
    expect(record.evidenceJson).toBeNull();
    expect(record.createdAt).toBeInstanceOf(Date);
    expect(record.updatedAt).toBeInstanceOf(Date);
  });

  it("一对一约束：同 toolCallId 二次创建 → ValidationError", async () => {
    const tenantId = await seedTenant();
    const toolCall = await seedToolCall(tenantId);

    await createEffectRecord({
      tenantId,
      toolCallId: toolCall.id,
      effectType: "send",
      targetSummaryJson: { total: 1 },
    });

    await expect(
      createEffectRecord({
        tenantId,
        toolCallId: toolCall.id,
        effectType: "send",
        targetSummaryJson: { total: 1 },
      }),
    ).rejects.toThrow(EffectValidationError);
  });

  it("指定 initialEffectState=unknown_effect 时直接进入 unknown_effect", async () => {
    const tenantId = await seedTenant();
    const toolCall = await seedToolCall(tenantId);

    const record = await createEffectRecord({
      tenantId,
      toolCallId: toolCall.id,
      effectType: "deploy",
      targetSummaryJson: { total: 1 },
      initialEffectState: "unknown_effect",
    });

    expect(record.effectState).toBe("unknown_effect");
  });

  it("空 tenantId / toolCallId → ValidationError", async () => {
    await expect(
      createEffectRecord({
        tenantId: "",
        toolCallId: "tc-1",
        effectType: "send",
        targetSummaryJson: { total: 1 },
      }),
    ).rejects.toThrow(EffectValidationError);

    const tenantId = await seedTenant();
    await expect(
      createEffectRecord({
        tenantId,
        toolCallId: "",
        effectType: "send",
        targetSummaryJson: { total: 1 },
      }),
    ).rejects.toThrow(EffectValidationError);
  });

  it("非法 effectType → ValidationError", async () => {
    const tenantId = await seedTenant();
    const toolCall = await seedToolCall(tenantId);

    await expect(
      createEffectRecord({
        tenantId,
        toolCallId: toolCall.id,
        effectType: "rollback" as never,
        targetSummaryJson: { total: 1 },
      }),
    ).rejects.toThrow(EffectValidationError);
  });

  it("targetSummaryJson 非对象 → ValidationError", async () => {
    const tenantId = await seedTenant();
    const toolCall = await seedToolCall(tenantId);

    await expect(
      createEffectRecord({
        tenantId,
        toolCallId: toolCall.id,
        effectType: "send",
        targetSummaryJson: "string-not-object",
      }),
    ).rejects.toThrow(EffectValidationError);
  });

  it("externalIdempotencyKey 超过 128 字符 → ValidationError", async () => {
    const tenantId = await seedTenant();
    const toolCall = await seedToolCall(tenantId);

    await expect(
      createEffectRecord({
        tenantId,
        toolCallId: toolCall.id,
        effectType: "send",
        targetSummaryJson: { total: 1 },
        externalIdempotencyKey: "x".repeat(129),
      }),
    ).rejects.toThrow(EffectValidationError);
  });
});

// ═══════════════════════════════════════════════════════════
// 3. createEffectTargets：批量 + 自动 hash + UNIQUE 重复
// ═══════════════════════════════════════════════════════════

describe("V11 createEffectTargets：批量 + 自动 hash + UNIQUE 重复", () => {
  it("批量创建 + 自动计算 targetHash + 默认 unknown 状态", async () => {
    const tenantId = await seedTenant();
    const { record } = await seedEffectRecordWithTargets(tenantId, {
      targetRefs: ["user:email:a@x.com", "user:email:b@x.com"],
    });

    const targets = await listEffectTargets(tenantId, record.id);
    expect(targets).toHaveLength(2);
    // listEffectTargets 按 targetHash 升序排序，不保证插入顺序——以 ref 为键校验。
    const byRef = new Map(targets.map((t) => [t.targetRef, t]));
    expect(byRef.get("user:email:a@x.com")?.targetHash).toBe(
      computeTargetHash("user:email:a@x.com"),
    );
    expect(byRef.get("user:email:a@x.com")?.targetState).toBe("unknown");
    expect(byRef.get("user:email:b@x.com")?.targetHash).toBe(
      computeTargetHash("user:email:b@x.com"),
    );
  });

  it("调用方提供 targetHash 时使用提供的", async () => {
    const tenantId = await seedTenant();
    const toolCall = await seedToolCall(tenantId);
    const record = await createEffectRecord({
      tenantId,
      toolCallId: toolCall.id,
      effectType: "create",
      targetSummaryJson: { total: 1 },
    });

    const customHash = buildValidHash("custom-target-1");
    const targets = await createEffectTargets({
      tenantId,
      effectRecordId: record.id,
      targets: [{ targetRef: "file:/tmp/foo.txt", targetHash: customHash }],
    });

    expect(targets[0]?.targetHash).toBe(customHash);
  });

  it("targets 内 targetHash 重复 → ValidationError", async () => {
    const tenantId = await seedTenant();
    const toolCall = await seedToolCall(tenantId);
    const record = await createEffectRecord({
      tenantId,
      toolCallId: toolCall.id,
      effectType: "create",
      targetSummaryJson: { total: 2 },
    });

    const hash = buildValidHash("dup-target");
    await expect(
      createEffectTargets({
        tenantId,
        effectRecordId: record.id,
        targets: [
          { targetRef: "ref-1", targetHash: hash },
          { targetRef: "ref-2", targetHash: hash },
        ],
      }),
    ).rejects.toThrow(EffectValidationError);
  });

  it("UNIQUE(effectRecordId, targetHash)：DB 级重复 → 抛错", async () => {
    const tenantId = await seedTenant();
    const { record } = await seedEffectRecordWithTargets(tenantId, {
      targetRefs: ["user:email:dup@x.com"],
    });

    // 同 targetRef 二次插入应触发 UNIQUE 冲突
    await expect(
      createEffectTargets({
        tenantId,
        effectRecordId: record.id,
        targets: [{ targetRef: "user:email:dup@x.com" }],
      }),
    ).rejects.toThrow();
  });

  it("空 targets 数组 → ValidationError", async () => {
    const tenantId = await seedTenant();
    const toolCall = await seedToolCall(tenantId);
    const record = await createEffectRecord({
      tenantId,
      toolCallId: toolCall.id,
      effectType: "create",
      targetSummaryJson: { total: 0 },
    });

    await expect(
      createEffectTargets({
        tenantId,
        effectRecordId: record.id,
        targets: [],
      }),
    ).rejects.toThrow(EffectValidationError);
  });

  it("非法 targetHash 格式 → ValidationError", async () => {
    const tenantId = await seedTenant();
    const toolCall = await seedToolCall(tenantId);
    const record = await createEffectRecord({
      tenantId,
      toolCallId: toolCall.id,
      effectType: "create",
      targetSummaryJson: { total: 1 },
    });

    await expect(
      createEffectTargets({
        tenantId,
        effectRecordId: record.id,
        targets: [{ targetRef: "ref-1", targetHash: "not-a-hash" }],
      }),
    ).rejects.toThrow(EffectValidationError);
  });

  it("初始状态 confirmed_success 透传", async () => {
    const tenantId = await seedTenant();
    const toolCall = await seedToolCall(tenantId);
    const record = await createEffectRecord({
      tenantId,
      toolCallId: toolCall.id,
      effectType: "create",
      targetSummaryJson: { total: 1 },
    });

    const targets = await createEffectTargets({
      tenantId,
      effectRecordId: record.id,
      targets: [
        {
          targetRef: "file:/tmp/foo.txt",
          initialTargetState: "confirmed_success",
        },
      ],
    });

    expect(targets[0]?.targetState).toBe("confirmed_success");
  });
});

// ═══════════════════════════════════════════════════════════
// 4. 查询 + 跨租户隔离
// ═══════════════════════════════════════════════════════════

describe("V11 EffectRecord 查询 + 跨租户隔离", () => {
  it("getEffectRecordById：跨租户返回 null", async () => {
    const tenantId = await seedTenant();
    const { record } = await seedEffectRecordWithTargets(tenantId);

    const found = await getEffectRecordById(tenantId, record.id);
    expect(found?.id).toBe(record.id);

    const otherTenant = await getEffectRecordById(randomUUID(), record.id);
    expect(otherTenant).toBeNull();
  });

  it("getEffectRecordByToolCall：跨租户返回 null", async () => {
    const tenantId = await seedTenant();
    const { toolCall, record } = await seedEffectRecordWithTargets(tenantId);

    const found = await getEffectRecordByToolCall(tenantId, toolCall.id);
    expect(found?.id).toBe(record.id);

    const otherTenant = await getEffectRecordByToolCall(randomUUID(), toolCall.id);
    expect(otherTenant).toBeNull();
  });

  it("listEffectTargets：跨租户返回空数组", async () => {
    const tenantId = await seedTenant();
    const { record, targets } = await seedEffectRecordWithTargets(tenantId, {
      targetRefs: ["a", "b", "c"],
    });

    const found = await listEffectTargets(tenantId, record.id);
    expect(found).toHaveLength(3);

    const otherTenant = await listEffectTargets(randomUUID(), record.id);
    expect(otherTenant).toEqual([]);
    expect(targets).toHaveLength(3);
  });

  it("listEffectRecordsByInvocation：联表查询 + 按 callSequence 升序", async () => {
    const tenantId = await seedTenant();
    // 同一 invocation 下创建 3 个 ToolCall + EffectRecord
    const invocationId = randomUUID();
    const toolCall1 = await createToolCall({
      tenantId,
      invocationId,
      toolId: randomUUID(),
      toolSchemaRevisionId: randomUUID(),
      schemaHash: "sha256:7d8e2f1a3b4c5d6e7f8a9b0c1d2e3f4a5b6c7d8e9f0a1b2c3d4e5f6a7b8c9d0e",
      operationId: `op-1-${randomUUID()}`,
      argumentsRedactedJson: { idx: 1 },
    });
    const toolCall2 = await createToolCall({
      tenantId,
      invocationId,
      toolId: randomUUID(),
      toolSchemaRevisionId: randomUUID(),
      schemaHash: "sha256:7d8e2f1a3b4c5d6e7f8a9b0c1d2e3f4a5b6c7d8e9f0a1b2c3d4e5f6a7b8c9d0e",
      operationId: `op-2-${randomUUID()}`,
      argumentsRedactedJson: { idx: 2 },
    });

    const r1 = await createEffectRecord({
      tenantId,
      toolCallId: toolCall1.id,
      effectType: "send",
      targetSummaryJson: { total: 1 },
    });
    const r2 = await createEffectRecord({
      tenantId,
      toolCallId: toolCall2.id,
      effectType: "send",
      targetSummaryJson: { total: 1 },
    });

    const records = await listEffectRecordsByInvocation(tenantId, invocationId);
    expect(records).toHaveLength(2);
    expect(records[0]?.id).toBe(r1.id);
    expect(records[1]?.id).toBe(r2.id);

    // 跨租户查询返回空
    const otherTenant = await listEffectRecordsByInvocation(randomUUID(), invocationId);
    expect(otherTenant).toEqual([]);
  });

  it("listEffectRecordsByState：按状态过滤 + limit", async () => {
    const tenantId = await seedTenant();
    // 创建 3 个 unknown_effect + 1 个 not_started
    const unknown1 = await seedEffectRecordWithTargets(tenantId, {
      initialToolCallState: "unknown_effect",
    });
    const unknown2 = await seedEffectRecordWithTargets(tenantId, {
      initialToolCallState: "unknown_effect",
    });
    const notStarted = await seedEffectRecordWithTargets(tenantId, {
      initialToolCallState: "running",
    });

    const unknownRecords = await listEffectRecordsByState(tenantId, "unknown_effect");
    expect(unknownRecords).toHaveLength(2);
    expect(unknownRecords.map((r) => r.id).sort()).toEqual(
      [unknown1.record.id, unknown2.record.id].sort(),
    );

    const notStartedRecords = await listEffectRecordsByState(tenantId, "not_started");
    expect(notStartedRecords).toHaveLength(1);
    expect(notStartedRecords[0]?.id).toBe(notStarted.record.id);

    const limitResults = await listEffectRecordsByState(tenantId, "unknown_effect", { limit: 1 });
    expect(limitResults).toHaveLength(1);
  });
});

// ═══════════════════════════════════════════════════════════
// 5. reconcileEffect：Gateway 路径
// ═══════════════════════════════════════════════════════════

describe("V11 reconcileEffect：Gateway 路径（provider_query + operation_id）", () => {
  it("成功 reconcile 全部 success → confirmed_success + call_state=succeeded", async () => {
    const tenantId = await seedTenant();
    const operationId = `op-success-${randomUUID()}`;
    const { toolCall, record, targets } = await seedEffectRecordWithTargets(tenantId, {
      targetRefs: ["a", "b"],
      initialToolCallState: "unknown_effect",
      operationId,
    });

    const result = await reconcileEffect({
      tenantId,
      toolCallId: toolCall.id,
      path: "gateway",
      verificationMethod: "provider_query",
      expectedOperationId: operationId,
      targetUpdates: [
        { targetHash: targets[0]?.targetHash ?? "", targetState: "confirmed_success" },
        { targetHash: targets[1]?.targetHash ?? "", targetState: "confirmed_success" },
      ],
    });

    expect(result.effectRecord.effectState).toBe("confirmed_success");
    expect(result.effectRecord.verificationMethod).toBe("provider_query");
    expect(result.effectRecord.verifiedAt).toBeInstanceOf(Date);
    expect(result.effectRecord.versionNo).toBe(2);
    expect(result.toolCall.callState).toBe("succeeded");
    expect(result.targetsCount).toEqual({
      total: 2,
      confirmed_success: 2,
      confirmed_failure: 0,
      unknown: 0,
    });
    expect(record.id).toBe(result.effectRecord.id);
  });

  it("operation_id 不匹配 → EffectOperationMismatchError", async () => {
    const tenantId = await seedTenant();
    const { toolCall, targets } = await seedEffectRecordWithTargets(tenantId, {
      initialToolCallState: "unknown_effect",
      operationId: "op-original",
    });

    await expect(
      reconcileEffect({
        tenantId,
        toolCallId: toolCall.id,
        path: "gateway",
        verificationMethod: "provider_query",
        expectedOperationId: "op-wrong",
        targetUpdates: [
          { targetHash: targets[0]?.targetHash ?? "", targetState: "confirmed_success" },
        ],
      }),
    ).rejects.toThrow(EffectOperationMismatchError);
  });

  it("gateway 路径 + manual_evidence → EffectVerificationMethodNotAllowedError", async () => {
    const tenantId = await seedTenant();
    const { toolCall, targets } = await seedEffectRecordWithTargets(tenantId, {
      initialToolCallState: "unknown_effect",
    });

    await expect(
      reconcileEffect({
        tenantId,
        toolCallId: toolCall.id,
        path: "gateway",
        verificationMethod: "manual_evidence",
        expectedOperationId: "op",
        targetUpdates: [
          { targetHash: targets[0]?.targetHash ?? "", targetState: "confirmed_success" },
        ],
      }),
    ).rejects.toThrow(EffectVerificationMethodNotAllowedError);
  });

  it("gateway 路径 + callback_evidence → EffectVerificationMethodNotAllowedError", async () => {
    const tenantId = await seedTenant();
    const { toolCall, targets } = await seedEffectRecordWithTargets(tenantId, {
      initialToolCallState: "unknown_effect",
    });

    await expect(
      reconcileEffect({
        tenantId,
        toolCallId: toolCall.id,
        path: "gateway",
        verificationMethod: "callback_evidence",
        expectedOperationId: "op",
        targetUpdates: [
          { targetHash: targets[0]?.targetHash ?? "", targetState: "confirmed_success" },
        ],
      }),
    ).rejects.toThrow(EffectVerificationMethodNotAllowedError);
  });

  it("gateway 路径缺 expectedOperationId → ValidationError", async () => {
    const tenantId = await seedTenant();
    const { toolCall, targets } = await seedEffectRecordWithTargets(tenantId, {
      initialToolCallState: "unknown_effect",
    });

    await expect(
      reconcileEffect({
        tenantId,
        toolCallId: toolCall.id,
        path: "gateway",
        verificationMethod: "provider_query",
        targetUpdates: [
          { targetHash: targets[0]?.targetHash ?? "", targetState: "confirmed_success" },
        ],
      }),
    ).rejects.toThrow(EffectValidationError);
  });
});

// ═══════════════════════════════════════════════════════════
// 6. reconcileEffect：Admin 路径
// ═══════════════════════════════════════════════════════════

describe("V11 reconcileEffect：Admin 路径（三种 verification_method）", () => {
  it("admin + manual_evidence 成功：confirmed_failure → call_state=failed", async () => {
    const tenantId = await seedTenant();
    const { toolCall, targets } = await seedEffectRecordWithTargets(tenantId, {
      targetRefs: ["a", "b"],
      initialToolCallState: "unknown_effect",
    });

    const result = await reconcileEffect({
      tenantId,
      toolCallId: toolCall.id,
      path: "admin",
      verificationMethod: "manual_evidence",
      targetUpdates: [
        { targetHash: targets[0]?.targetHash ?? "", targetState: "confirmed_failure" },
        { targetHash: targets[1]?.targetHash ?? "", targetState: "confirmed_failure" },
      ],
      evidenceJson: { source: "manual", approver: "admin-001" },
      externalResultRef: "evidence://effect/approved-7",
    });

    expect(result.effectRecord.effectState).toBe("confirmed_failure");
    expect(result.effectRecord.verificationMethod).toBe("manual_evidence");
    expect(result.effectRecord.evidenceJson).toEqual({ source: "manual", approver: "admin-001" });
    expect(result.effectRecord.externalResultRef).toBe("evidence://effect/approved-7");
    expect(result.toolCall.callState).toBe("failed");
    expect(result.targetsCount).toEqual({
      total: 2,
      confirmed_success: 0,
      confirmed_failure: 2,
      unknown: 0,
    });
  });

  it("admin + callback_evidence 成功：confirmed_partial → call_state=succeeded", async () => {
    const tenantId = await seedTenant();
    const { toolCall, targets } = await seedEffectRecordWithTargets(tenantId, {
      targetRefs: ["a", "b"],
      initialToolCallState: "unknown_effect",
    });

    const result = await reconcileEffect({
      tenantId,
      toolCallId: toolCall.id,
      path: "admin",
      verificationMethod: "callback_evidence",
      targetUpdates: [
        { targetHash: targets[0]?.targetHash ?? "", targetState: "confirmed_success" },
        { targetHash: targets[1]?.targetHash ?? "", targetState: "confirmed_failure" },
      ],
    });

    expect(result.effectRecord.effectState).toBe("confirmed_partial");
    expect(result.toolCall.callState).toBe("succeeded");
    expect(result.targetsCount).toEqual({
      total: 2,
      confirmed_success: 1,
      confirmed_failure: 1,
      unknown: 0,
    });
  });

  it("admin + provider_query 成功（与 Gateway 共享 method）", async () => {
    const tenantId = await seedTenant();
    const { toolCall, targets } = await seedEffectRecordWithTargets(tenantId, {
      initialToolCallState: "unknown_effect",
    });

    const result = await reconcileEffect({
      tenantId,
      toolCallId: toolCall.id,
      path: "admin",
      verificationMethod: "provider_query",
      targetUpdates: [
        { targetHash: targets[0]?.targetHash ?? "", targetState: "confirmed_success" },
      ],
    });

    expect(result.effectRecord.verificationMethod).toBe("provider_query");
  });

  it("admin 路径不强制 expectedOperationId", async () => {
    const tenantId = await seedTenant();
    const { toolCall, targets } = await seedEffectRecordWithTargets(tenantId, {
      targetRefs: ["a"],
      initialToolCallState: "unknown_effect",
      operationId: "op-original",
    });

    // 不传 expectedOperationId 也能成功（admin 路径）
    const result = await reconcileEffect({
      tenantId,
      toolCallId: toolCall.id,
      path: "admin",
      verificationMethod: "provider_query",
      targetUpdates: [
        { targetHash: targets[0]?.targetHash ?? "", targetState: "confirmed_success" },
      ],
    });

    expect(result.effectRecord.effectState).toBe("confirmed_success");
  });
});

// ═══════════════════════════════════════════════════════════
// 7. reconcileEffect：状态机 + 多次 reconcile
// ═══════════════════════════════════════════════════════════

describe("V11 reconcileEffect：状态机 + 多次 reconcile", () => {
  it("unknown_effect 保持：仅部分 target 确认，仍含 unknown → call_state 保持 unknown_effect", async () => {
    const tenantId = await seedTenant();
    const { toolCall, targets } = await seedEffectRecordWithTargets(tenantId, {
      targetRefs: ["a", "b", "c"],
      initialToolCallState: "unknown_effect",
    });

    const result = await reconcileEffect({
      tenantId,
      toolCallId: toolCall.id,
      path: "admin",
      verificationMethod: "provider_query",
      targetUpdates: [
        { targetHash: targets[0]?.targetHash ?? "", targetState: "confirmed_success" },
        // targets[1] / targets[2] 仍为 unknown
      ],
    });

    expect(result.effectRecord.effectState).toBe("unknown_effect");
    expect(result.toolCall.callState).toBe("unknown_effect");
    expect(result.targetsCount).toEqual({
      total: 3,
      confirmed_success: 1,
      confirmed_failure: 0,
      unknown: 2,
    });
  });

  it("多次 reconcile 直到所有 target 确认 → 最终 confirmed_partial", async () => {
    const tenantId = await seedTenant();
    const { toolCall, targets } = await seedEffectRecordWithTargets(tenantId, {
      targetRefs: ["a", "b", "c"],
      initialToolCallState: "unknown_effect",
    });

    // 第一次：确认 a
    await reconcileEffect({
      tenantId,
      toolCallId: toolCall.id,
      path: "admin",
      verificationMethod: "provider_query",
      targetUpdates: [
        { targetHash: targets[0]?.targetHash ?? "", targetState: "confirmed_success" },
      ],
    });

    // 第二次：确认 b 失败
    const result = await reconcileEffect({
      tenantId,
      toolCallId: toolCall.id,
      path: "admin",
      verificationMethod: "callback_evidence",
      targetUpdates: [
        { targetHash: targets[1]?.targetHash ?? "", targetState: "confirmed_failure" },
      ],
    });
    expect(result.effectRecord.effectState).toBe("unknown_effect");
    expect(result.toolCall.callState).toBe("unknown_effect");

    // 第三次：确认 c 成功 → 全部确认，进入 confirmed_partial
    const final = await reconcileEffect({
      tenantId,
      toolCallId: toolCall.id,
      path: "admin",
      verificationMethod: "provider_query",
      targetUpdates: [
        { targetHash: targets[2]?.targetHash ?? "", targetState: "confirmed_success" },
      ],
    });
    expect(final.effectRecord.effectState).toBe("confirmed_partial");
    expect(final.toolCall.callState).toBe("succeeded");
    expect(final.effectRecord.versionNo).toBe(4); // 初始1 + 三次 reconcile
  });

  it("终态（confirmed_success）再 reconcile → EffectAlreadyConfirmedError", async () => {
    const tenantId = await seedTenant();
    const { toolCall, targets } = await seedEffectRecordWithTargets(tenantId, {
      targetRefs: ["a"],
      initialToolCallState: "unknown_effect",
    });

    // 首次 reconcile 进入 confirmed_success
    await reconcileEffect({
      tenantId,
      toolCallId: toolCall.id,
      path: "admin",
      verificationMethod: "provider_query",
      targetUpdates: [
        { targetHash: targets[0]?.targetHash ?? "", targetState: "confirmed_success" },
      ],
    });

    // 二次 reconcile 应抛错
    await expect(
      reconcileEffect({
        tenantId,
        toolCallId: toolCall.id,
        path: "admin",
        verificationMethod: "provider_query",
        targetUpdates: [
          { targetHash: targets[0]?.targetHash ?? "", targetState: "confirmed_failure" },
        ],
      }),
    ).rejects.toThrow(EffectAlreadyConfirmedError);
  });

  it("targetHash 不存在 → EffectTargetNotFoundError", async () => {
    const tenantId = await seedTenant();
    const { toolCall } = await seedEffectRecordWithTargets(tenantId, {
      initialToolCallState: "unknown_effect",
    });

    const fakeHash = buildValidHash("nonexistent-target");
    await expect(
      reconcileEffect({
        tenantId,
        toolCallId: toolCall.id,
        path: "admin",
        verificationMethod: "provider_query",
        targetUpdates: [{ targetHash: fakeHash, targetState: "confirmed_success" }],
      }),
    ).rejects.toThrow(EffectTargetNotFoundError);
  });

  it("EffectRecord 不存在 → EffectNotFoundError", async () => {
    const tenantId = await seedTenant();
    const toolCall = await seedToolCall(tenantId);

    await expect(
      reconcileEffect({
        tenantId,
        toolCallId: toolCall.id,
        path: "admin",
        verificationMethod: "provider_query",
        targetUpdates: [],
      }),
    ).rejects.toThrow(EffectNotFoundError);
  });

  it("跨租户 reconcile → EffectNotFoundError", async () => {
    const tenantId = await seedTenant();
    const { toolCall, targets } = await seedEffectRecordWithTargets(tenantId, {
      initialToolCallState: "unknown_effect",
    });

    await expect(
      reconcileEffect({
        tenantId: randomUUID(),
        toolCallId: toolCall.id,
        path: "admin",
        verificationMethod: "provider_query",
        targetUpdates: [
          { targetHash: targets[0]?.targetHash ?? "", targetState: "confirmed_success" },
        ],
      }),
    ).rejects.toThrow(EffectNotFoundError);
  });

  it("非法 path → ValidationError", async () => {
    const tenantId = await seedTenant();
    const { toolCall } = await seedEffectRecordWithTargets(tenantId, {
      initialToolCallState: "unknown_effect",
    });

    await expect(
      reconcileEffect({
        tenantId,
        toolCallId: toolCall.id,
        path: "internal" as never,
        verificationMethod: "provider_query",
        targetUpdates: [],
      }),
    ).rejects.toThrow(EffectValidationError);
  });

  it("空 targetUpdates + unknown 状态保持 → 仅刷新 verifiedAt", async () => {
    const tenantId = await seedTenant();
    const { toolCall } = await seedEffectRecordWithTargets(tenantId, {
      targetRefs: ["a"],
      initialToolCallState: "unknown_effect",
    });

    const result = await reconcileEffect({
      tenantId,
      toolCallId: toolCall.id,
      path: "admin",
      verificationMethod: "provider_query",
      targetUpdates: [],
    });

    // 所有 target 仍为 unknown → effect_state 保持 unknown_effect
    expect(result.effectRecord.effectState).toBe("unknown_effect");
    expect(result.effectRecord.verifiedAt).toBeInstanceOf(Date);
    expect(result.toolCall.callState).toBe("unknown_effect");
  });
});

// ═══════════════════════════════════════════════════════════
// 8. markToolCallUnknownEffect：便捷函数
// ═══════════════════════════════════════════════════════════

describe("V11 markToolCallUnknownEffect：便捷函数", () => {
  it("成功创建 EffectRecord + 迁移 ToolCall 到 unknown_effect", async () => {
    const tenantId = await seedTenant();
    // ToolCall 初始为 proposed
    const toolCall = await seedToolCall(tenantId, { initialState: "running" });

    const { effectRecord, effectTargets } = await markToolCallUnknownEffect({
      tenantId,
      toolCallId: toolCall.id,
      effectType: "send",
      targetSummaryJson: { total: 2, description: "群发邮件超时" },
      targets: [{ targetRef: "user:email:a@x.com" }, { targetRef: "user:email:b@x.com" }],
    });

    expect(effectRecord.effectState).toBe("unknown_effect");
    expect(effectRecord.toolCallId).toBe(toolCall.id);
    expect(effectTargets).toHaveLength(2);

    // ToolCall.call_state 已迁移到 unknown_effect
    const after = await getToolCallById({ tenantId, toolCallId: toolCall.id });
    expect(after?.callState).toBe("unknown_effect");
  });

  it("幂等：已存在 EffectRecord 时跳过创建", async () => {
    const tenantId = await seedTenant();
    const toolCall = await seedToolCall(tenantId, { initialState: "running" });

    // 第一次调用：创建
    const first = await markToolCallUnknownEffect({
      tenantId,
      toolCallId: toolCall.id,
      effectType: "send",
      targetSummaryJson: { total: 1 },
    });
    expect(first.effectRecord.effectState).toBe("unknown_effect");

    // 第二次调用：应跳过创建（返回相同 record）
    const second = await markToolCallUnknownEffect({
      tenantId,
      toolCallId: toolCall.id,
      effectType: "send",
      targetSummaryJson: { total: 1 },
    });
    expect(second.effectRecord.id).toBe(first.effectRecord.id);
  });

  it("幂等：targets 已存在时跳过创建", async () => {
    const tenantId = await seedTenant();
    const toolCall = await seedToolCall(tenantId, { initialState: "running" });

    const targets = [{ targetRef: "user:email:a@x.com" }, { targetRef: "user:email:b@x.com" }];

    const first = await markToolCallUnknownEffect({
      tenantId,
      toolCallId: toolCall.id,
      effectType: "send",
      targetSummaryJson: { total: 2 },
      targets,
    });
    expect(first.effectTargets).toHaveLength(2);

    // 第二次调用：targets 应保持 2 个（不重复创建）
    const second = await markToolCallUnknownEffect({
      tenantId,
      toolCallId: toolCall.id,
      effectType: "send",
      targetSummaryJson: { total: 2 },
      targets,
    });
    expect(second.effectTargets).toHaveLength(2);
  });

  it("ToolCall 不存在 → EffectNotFoundError", async () => {
    const tenantId = await seedTenant();

    await expect(
      markToolCallUnknownEffect({
        tenantId,
        toolCallId: randomUUID(),
        effectType: "send",
        targetSummaryJson: { total: 1 },
      }),
    ).rejects.toThrow(EffectNotFoundError);
  });

  it("跨租户 → EffectNotFoundError", async () => {
    const tenantId = await seedTenant();
    const toolCall = await seedToolCall(tenantId, { initialState: "running" });

    await expect(
      markToolCallUnknownEffect({
        tenantId: randomUUID(),
        toolCallId: toolCall.id,
        effectType: "send",
        targetSummaryJson: { total: 1 },
      }),
    ).rejects.toThrow(EffectNotFoundError);
  });
});
