import {
  GET as getReviewGET,
  POST as resolveReviewPOST,
} from "@/app/admin/api/v1/capability-reviews/[review_id]/route";
import {
  POST as createReviewPOST,
  GET as listReviewsGET,
} from "@/app/admin/api/v1/capability-reviews/route";
/**
 * S06-C05：V11 ToolCall / CapabilityReview / RiskDiff 仓储与 Admin API 集成测试
 * （真实 MySQL 8 Testcontainers）。
 *
 * 覆盖：
 * - computeArgumentsHash / computeCapabilityUseKey 工具。
 * - compareSchemaRevisions / isAutoEffective / requiresCentralReview / normalizeRiskMetadata
 *   （覆盖全部 10 种 RiskDiffType）。
 * - ToolCall 仓储：createToolCall / getToolCallById / getToolCallByOperation /
 *   listToolCallsByInvocation / updateToolCallState + 幂等与冲突。
 * - CapabilityReview 仓储：createCapabilityReview / getCapabilityReviewById /
 *   listPendingReviews / resolveCapabilityReview + 状态机。
 * - Admin API：
 *   - POST /admin/api/v1/capability-reviews
 *   - GET /admin/api/v1/capability-reviews
 *   - GET /admin/api/v1/capability-reviews/{review_id}
 *   - POST /admin/api/v1/capability-reviews/{review_id}
 *
 * 真实 MySQL 8 Testcontainers，不使用 mock。Admin API 测试需 SNOW_AUTH_MODE=dev +
 * grantActionBinding 绑定 capability.review。
 */
import { DEFAULT_USER_EMAIL, DEFAULT_USER_ID, DEFAULT_USER_NAME } from "@/lib/constants";
import { db } from "@/lib/db/client";
import { assertCrossTenantHidden, buildV11Request } from "@/lib/db/test/api-fixtures";
import { resetDatabase } from "@/lib/db/test/mysql-harness";
import { upsertPrincipalBinding } from "@/lib/identity/principal-binding-queries";
import { grantActionBinding } from "@/lib/identity/role-action-queries";
import { ensureDefaultTenant } from "@/lib/identity/tenant-queries";
import { upsertUserIdentity } from "@/lib/identity/user-identity-queries";
import { computeContentHash } from "@/lib/v11/capability/content-cache";
import {
  type RiskDiffType,
  type RiskMetadata,
  compareSchemaRevisions,
  isAutoEffective,
  normalizeRiskMetadata,
  requiresCentralReview,
} from "@/lib/v11/capability/risk-diff";
import {
  CapabilityReviewNotFoundError,
  CapabilityReviewStateError,
  CapabilityReviewValidationError,
  createCapabilityReview,
  getCapabilityReviewById,
  listPendingReviews,
  resolveCapabilityReview,
} from "@/lib/v11/capability/risk-review-queries";
import {
  ToolCallConflictError,
  ToolCallNotFoundError,
  ToolCallStateError,
  ToolCallValidationError,
  computeArgumentsHash,
  createToolCall,
  getToolCallById,
  getToolCallByOperation,
  listToolCallsByInvocation,
  updateToolCallState,
} from "@/lib/v11/capability/tool-call-queries";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

// vitest 不加载 .env.test，需手动设置 SNOW_AUTH_MODE=dev（与 skill.test.ts 一致）。
const ORIGINAL_AUTH_MODE = process.env.SNOW_AUTH_MODE;

beforeEach(async () => {
  process.env.SNOW_AUTH_MODE = "dev";
  await resetDatabase(db);
});

afterEach(() => {
  process.env.SNOW_AUTH_MODE = ORIGINAL_AUTH_MODE;
});

// ─── 辅助：seed admin 用户 + capability.review action binding ─────────

async function seedAdminWithCapabilityReviewBindings() {
  const tenant = await ensureDefaultTenant();
  const identity = await upsertUserIdentity({
    tenantId: tenant.id,
    externalSubject: DEFAULT_USER_ID,
    email: DEFAULT_USER_EMAIL,
    displayName: DEFAULT_USER_NAME,
  });
  const binding = await upsertPrincipalBinding({
    tenantId: tenant.id,
    subjectType: "user",
    externalId: DEFAULT_USER_ID,
    displayName: DEFAULT_USER_NAME,
    userIdentityId: identity.id,
  });
  // capability.review：tenant wildcard（本租户内所有审核记录）。
  await grantActionBinding({
    tenantId: tenant.id,
    principalBindingId: binding.id,
    actionCode: "capability.review",
    resourceScope: { type: "tenant", wildcard: true },
  });
  return { tenantId: tenant.id, userIdentityId: identity.id };
}

/** 构造一个合法的 sha256: hash（用于 ToolCall.schemaHash）。 */
function buildValidHash(content: string): string {
  return computeContentHash(content);
}

/** 构造 compareSchemaRevisions 入参的最小化 helper。 */
function buildCompareParams(opts: {
  oldMeta?: RiskMetadata | null;
  newMeta: RiskMetadata;
  oldRevisionId?: string | null;
  affectedAgents?: string[];
}) {
  return {
    resourceType: "tool" as const,
    resourceId: "tool-001",
    oldRevisionId: opts.oldRevisionId ?? "rev-old-001",
    newRevisionId: "rev-new-001",
    oldRiskMetadata: opts.oldMeta ?? null,
    newRiskMetadata: opts.newMeta,
    affectedAgents: opts.affectedAgents ?? [],
  };
}

// ═══════════════════════════════════════════════════════════
// 1. computeArgumentsHash 工具
// ═══════════════════════════════════════════════════════════

describe("V11 computeArgumentsHash 工具", () => {
  it("computeArgumentsHash 返回 sha256: 前缀 + 64 hex", () => {
    const hash = computeArgumentsHash({ query: "hello" });
    expect(hash.startsWith("sha256:")).toBe(true);
    const hex = hash.slice("sha256:".length);
    expect(hex).toMatch(/^[0-9a-f]{64}$/);
    expect(hex.length).toBe(64);
  });

  it("computeArgumentsHash 相同输入产生相同 hash", () => {
    const a = computeArgumentsHash({ q: "x", n: 1 });
    const b = computeArgumentsHash({ q: "x", n: 1 });
    expect(a).toBe(b);
  });

  it("computeArgumentsHash 不同输入产生不同 hash", () => {
    const a = computeArgumentsHash({ q: "a" });
    const b = computeArgumentsHash({ q: "b" });
    expect(a).not.toBe(b);
  });

  it("computeArgumentsHash 非对象入参 → ToolCallValidationError", () => {
    expect(() => computeArgumentsHash(null)).toThrow(ToolCallValidationError);
    expect(() => computeArgumentsHash(undefined)).toThrow(ToolCallValidationError);
    expect(() => computeArgumentsHash("string")).toThrow(ToolCallValidationError);
    expect(() => computeArgumentsHash(42)).toThrow(ToolCallValidationError);
  });
});

// ═══════════════════════════════════════════════════════════
// 2. compareSchemaRevisions：10 种 RiskDiffType 覆盖
// ═══════════════════════════════════════════════════════════

describe("V11 compareSchemaRevisions：RiskDiffType 判定", () => {
  it("no_change：完全相同的 metadata → diffType=no_change, requiresReview=false", () => {
    const meta: RiskMetadata = {
      effect: "read_only",
      data_class: "internal",
      network_scope: "internal",
      credential_required: false,
      env: "test",
      idempotent: true,
    };
    const result = compareSchemaRevisions(
      buildCompareParams({ oldMeta: meta, newMeta: { ...meta } }),
    );
    expect(result.diffType).toBe("no_change");
    expect(result.requiresReview).toBe(false);
  });

  it("no_change：旧版空对象 + 新版空对象 → no_change", () => {
    const result = compareSchemaRevisions(buildCompareParams({ oldMeta: {}, newMeta: {} }));
    expect(result.diffType).toBe("no_change");
    expect(result.requiresReview).toBe(false);
  });

  it("read_to_write：effect read_only → write", () => {
    const result = compareSchemaRevisions(
      buildCompareParams({
        oldMeta: { effect: "read_only" },
        newMeta: { effect: "write" },
      }),
    );
    expect(result.diffType).toBe("read_to_write");
    expect(result.requiresReview).toBe(true);
  });

  it("read_to_write：effect read_only → destructive", () => {
    const result = compareSchemaRevisions(
      buildCompareParams({
        oldMeta: { effect: "read_only" },
        newMeta: { effect: "destructive" },
      }),
    );
    expect(result.diffType).toBe("read_to_write");
    expect(result.requiresReview).toBe(true);
  });

  it("read_to_write：首次发布 effect=write（旧版无 effect）", () => {
    const result = compareSchemaRevisions(
      buildCompareParams({
        oldMeta: {},
        newMeta: { effect: "write" },
      }),
    );
    expect(result.diffType).toBe("read_to_write");
    expect(result.requiresReview).toBe(true);
  });

  it("new_destructive_op：destructive false → true", () => {
    const result = compareSchemaRevisions(
      buildCompareParams({
        oldMeta: { effect: "write", destructive: false },
        newMeta: { effect: "write", destructive: true },
      }),
    );
    expect(result.diffType).toBe("new_destructive_op");
    expect(result.requiresReview).toBe(true);
  });

  it("new_destructive_op：effect write → destructive（destructive 字段未变）", () => {
    const result = compareSchemaRevisions(
      buildCompareParams({
        oldMeta: { effect: "write" },
        newMeta: { effect: "destructive" },
      }),
    );
    expect(result.diffType).toBe("new_destructive_op");
    expect(result.requiresReview).toBe(true);
  });

  it("network_expanded：network_scope internal → external", () => {
    const result = compareSchemaRevisions(
      buildCompareParams({
        oldMeta: { network_scope: "internal" },
        newMeta: { network_scope: "external" },
      }),
    );
    expect(result.diffType).toBe("network_expanded");
    expect(result.requiresReview).toBe(true);
  });

  it("network_expanded：network_scope none → public", () => {
    const result = compareSchemaRevisions(
      buildCompareParams({
        oldMeta: { network_scope: "none" },
        newMeta: { network_scope: "public" },
      }),
    );
    expect(result.diffType).toBe("network_expanded");
    expect(result.requiresReview).toBe(true);
  });

  it("data_destination_expanded：新增数据目的地", () => {
    const result = compareSchemaRevisions(
      buildCompareParams({
        oldMeta: { data_destinations: ["db-a"] },
        newMeta: { data_destinations: ["db-a", "db-b"] },
      }),
    );
    expect(result.diffType).toBe("data_destination_expanded");
    expect(result.requiresReview).toBe(true);
  });

  it("data_destination_expanded：首次发布有目的地（旧版空）", () => {
    const result = compareSchemaRevisions(
      buildCompareParams({
        oldMeta: {},
        newMeta: { data_destinations: ["new-dest"] },
      }),
    );
    expect(result.diffType).toBe("data_destination_expanded");
    expect(result.requiresReview).toBe(true);
  });

  it("new_credential：credential_required false → true", () => {
    const result = compareSchemaRevisions(
      buildCompareParams({
        oldMeta: { credential_required: false },
        newMeta: { credential_required: true },
      }),
    );
    expect(result.diffType).toBe("new_credential");
    expect(result.requiresReview).toBe(true);
  });

  it("new_credential：首次发布 credential_required=true", () => {
    const result = compareSchemaRevisions(
      buildCompareParams({
        oldMeta: {},
        newMeta: { credential_required: true },
      }),
    );
    expect(result.diffType).toBe("new_credential");
    expect(result.requiresReview).toBe(true);
  });

  it("new_permission_scope：permission_scope 新增", () => {
    const result = compareSchemaRevisions(
      buildCompareParams({
        oldMeta: { permission_scope: ["read:user"] },
        newMeta: { permission_scope: ["read:user", "write:repo"] },
      }),
    );
    expect(result.diffType).toBe("new_permission_scope");
    expect(result.requiresReview).toBe(true);
  });

  it("env_test_to_prod：env test → prod", () => {
    const result = compareSchemaRevisions(
      buildCompareParams({
        oldMeta: { env: "test" },
        newMeta: { env: "prod" },
      }),
    );
    expect(result.diffType).toBe("env_test_to_prod");
    expect(result.requiresReview).toBe(true);
  });

  it("env_test_to_prod：首次发布 env=prod", () => {
    const result = compareSchemaRevisions(
      buildCompareParams({
        oldMeta: {},
        newMeta: { env: "prod" },
      }),
    );
    expect(result.diffType).toBe("env_test_to_prod");
    expect(result.requiresReview).toBe(true);
  });

  it("lost_idempotency：idempotent true → false", () => {
    const result = compareSchemaRevisions(
      buildCompareParams({
        oldMeta: { idempotent: true },
        newMeta: { idempotent: false },
      }),
    );
    expect(result.diffType).toBe("lost_idempotency");
    expect(result.requiresReview).toBe(true);
  });

  it("compatible_change：data_class 调整（不触发审核）", () => {
    const result = compareSchemaRevisions(
      buildCompareParams({
        oldMeta: { data_class: "internal" },
        newMeta: { data_class: "confidential" },
      }),
    );
    expect(result.diffType).toBe("compatible_change");
    expect(result.requiresReview).toBe(false);
  });

  it("affectedAgents 透传到 RiskDiffResult", () => {
    const result = compareSchemaRevisions(
      buildCompareParams({
        oldMeta: { effect: "read_only" },
        newMeta: { effect: "write" },
        affectedAgents: ["agent-001", "agent-002"],
      }),
    );
    expect(result.affectedAgents).toEqual(["agent-001", "agent-002"]);
  });

  it("RiskDiffResult 字段透传：resourceType / oldRevisionId / newRevisionId", () => {
    const result = compareSchemaRevisions({
      resourceType: "skill",
      resourceId: "skill-001",
      oldRevisionId: "old-rev-id",
      newRevisionId: "new-rev-id",
      oldRiskMetadata: { effect: "read_only" },
      newRiskMetadata: { effect: "write" },
    });
    expect(result.resourceType).toBe("skill");
    expect(result.oldRevisionId).toBe("old-rev-id");
    expect(result.newRevisionId).toBe("new-rev-id");
  });

  it("oldRevisionId 为 null（首次发布）时 diffType 仍正确", () => {
    const result = compareSchemaRevisions({
      resourceType: "tool",
      resourceId: "tool-002",
      oldRevisionId: null,
      newRevisionId: "new-rev-002",
      oldRiskMetadata: null,
      newRiskMetadata: { effect: "write" },
    });
    expect(result.diffType).toBe("read_to_write");
    expect(result.oldRevisionId).toBeNull();
    expect(result.newRevisionId).toBe("new-rev-002");
  });
});

// ═══════════════════════════════════════════════════════════
// 3. isAutoEffective / requiresCentralReview / normalizeRiskMetadata
// ═══════════════════════════════════════════════════════════

describe("V11 isAutoEffective / requiresCentralReview", () => {
  it("isAutoEffective(no_change) → true", () => {
    expect(isAutoEffective("no_change")).toBe(true);
  });

  it("isAutoEffective(compatible_change) → true", () => {
    expect(isAutoEffective("compatible_change")).toBe(true);
  });

  it("isAutoEffective(read_to_write) → false", () => {
    expect(isAutoEffective("read_to_write")).toBe(false);
  });

  it("isAutoEffective(全部 8 类高风险) → false", () => {
    const highRiskTypes: RiskDiffType[] = [
      "read_to_write",
      "new_destructive_op",
      "network_expanded",
      "data_destination_expanded",
      "new_credential",
      "new_permission_scope",
      "env_test_to_prod",
      "lost_idempotency",
    ];
    for (const t of highRiskTypes) {
      expect(isAutoEffective(t)).toBe(false);
    }
  });

  it("requiresCentralReview(read_to_write) → true", () => {
    expect(requiresCentralReview("read_to_write")).toBe(true);
  });

  it("requiresCentralReview(全部 8 类高风险) → true", () => {
    const highRiskTypes: RiskDiffType[] = [
      "read_to_write",
      "new_destructive_op",
      "network_expanded",
      "data_destination_expanded",
      "new_credential",
      "new_permission_scope",
      "env_test_to_prod",
      "lost_idempotency",
    ];
    for (const t of highRiskTypes) {
      expect(requiresCentralReview(t)).toBe(true);
    }
  });

  it("requiresCentralReview(no_change / compatible_change) → false", () => {
    expect(requiresCentralReview("no_change")).toBe(false);
    expect(requiresCentralReview("compatible_change")).toBe(false);
  });
});

describe("V11 normalizeRiskMetadata", () => {
  it("normalizeRiskMetadata(null) → 空对象", () => {
    expect(normalizeRiskMetadata(null)).toEqual({});
    expect(normalizeRiskMetadata(undefined)).toEqual({});
  });

  it("normalizeRiskMetadata(非对象) → 空对象", () => {
    expect(normalizeRiskMetadata("string")).toEqual({});
    expect(normalizeRiskMetadata(42)).toEqual({});
    expect(normalizeRiskMetadata([])).toEqual({});
  });

  it("normalizeRiskMetadata：合法字段保留，非法字段忽略", () => {
    const result = normalizeRiskMetadata({
      effect: "read_only",
      data_class: "public",
      network_scope: "internal",
      data_destinations: ["a", "b"],
      credential_required: false,
      permission_scope: ["read:x"],
      env: "test",
      idempotent: true,
      side_effects: false,
      destructive: false,
      // 非法字段：
      effect_other: "xxx",
      unknown_field: 123,
    });
    expect(result.effect).toBe("read_only");
    expect(result.data_class).toBe("public");
    expect(result.network_scope).toBe("internal");
    expect(result.data_destinations).toEqual(["a", "b"]);
    expect(result.credential_required).toBe(false);
    expect(result.permission_scope).toEqual(["read:x"]);
    expect(result.env).toBe("test");
    expect(result.idempotent).toBe(true);
    expect(result.side_effects).toBe(false);
    expect(result.destructive).toBe(false);
  });

  it("normalizeRiskMetadata：非法枚举值忽略", () => {
    const result = normalizeRiskMetadata({
      effect: "invalid_effect",
      data_class: "unknown_class",
      network_scope: "everywhere",
      env: "production",
    });
    expect(result.effect).toBeUndefined();
    expect(result.data_class).toBeUndefined();
    expect(result.network_scope).toBeUndefined();
    expect(result.env).toBeUndefined();
  });

  it("normalizeRiskMetadata：类型不匹配字段忽略", () => {
    const result = normalizeRiskMetadata({
      effect: 123,
      data_destinations: "not-array",
      permission_scope: "not-array",
      credential_required: "yes",
      idempotent: 1,
    });
    expect(result.effect).toBeUndefined();
    expect(result.data_destinations).toBeUndefined();
    expect(result.permission_scope).toBeUndefined();
    expect(result.credential_required).toBeUndefined();
    expect(result.idempotent).toBeUndefined();
  });
});

// ═══════════════════════════════════════════════════════════
// 4. ToolCall 仓储：createToolCall / get / list / update
// ═══════════════════════════════════════════════════════════

describe("V11 ToolCall 仓储：createToolCall", () => {
  let tenantId: string;

  beforeEach(async () => {
    const seeded = await seedAdminWithCapabilityReviewBindings();
    tenantId = seeded.tenantId;
  });

  it("createToolCall 成功：默认 callState=proposed, callSequence=1", async () => {
    const toolCall = await createToolCall({
      tenantId,
      invocationId: "inv-001",
      toolId: "tool-001",
      toolSchemaRevisionId: "rev-001",
      schemaHash: buildValidHash("schema-001"),
      operationId: "op-001",
      argumentsRedactedJson: { query: "hello" },
    });
    expect(toolCall.id).toEqual(expect.any(String));
    expect(toolCall.tenantId).toBe(tenantId);
    expect(toolCall.invocationId).toBe("inv-001");
    expect(toolCall.toolId).toBe("tool-001");
    expect(toolCall.callSequence).toBe(1);
    expect(toolCall.callState).toBe("proposed");
    expect(toolCall.operationId).toBe("op-001");
    expect(toolCall.argumentsHash.startsWith("sha256:")).toBe(true);
    expect(toolCall.schemaHash).toBe(buildValidHash("schema-001"));
  });

  it("createToolCall 幂等：同 (toolId, operationId) 同 arguments → 返回已存在行", async () => {
    const args = { query: "same" };
    const first = await createToolCall({
      tenantId,
      invocationId: "inv-002",
      toolId: "tool-002",
      toolSchemaRevisionId: "rev-002",
      schemaHash: buildValidHash("schema-002"),
      operationId: "op-idem",
      argumentsRedactedJson: args,
    });
    const second = await createToolCall({
      tenantId,
      invocationId: "inv-002b",
      toolId: "tool-002",
      toolSchemaRevisionId: "rev-002",
      schemaHash: buildValidHash("schema-002"),
      operationId: "op-idem",
      argumentsRedactedJson: { query: "same" }, // 等价 JSON
    });
    expect(second.id).toBe(first.id);
    expect(second.argumentsHash).toBe(first.argumentsHash);
  });

  it("createToolCall 冲突：同 (toolId, operationId) 不同 arguments → ToolCallConflictError", async () => {
    await createToolCall({
      tenantId,
      invocationId: "inv-003",
      toolId: "tool-003",
      toolSchemaRevisionId: "rev-003",
      schemaHash: buildValidHash("schema-003"),
      operationId: "op-conflict",
      argumentsRedactedJson: { query: "a" },
    });
    await expect(
      createToolCall({
        tenantId,
        invocationId: "inv-003b",
        toolId: "tool-003",
        toolSchemaRevisionId: "rev-003",
        schemaHash: buildValidHash("schema-003"),
        operationId: "op-conflict",
        argumentsRedactedJson: { query: "b" },
      }),
    ).rejects.toThrow(ToolCallConflictError);
  });

  it("createToolCall：同 Invocation 内 callSequence 单调递增", async () => {
    const c1 = await createToolCall({
      tenantId,
      invocationId: "inv-004",
      toolId: "tool-004a",
      toolSchemaRevisionId: "rev-004a",
      schemaHash: buildValidHash("schema-004a"),
      operationId: "op-004a",
      argumentsRedactedJson: { x: 1 },
    });
    const c2 = await createToolCall({
      tenantId,
      invocationId: "inv-004",
      toolId: "tool-004b",
      toolSchemaRevisionId: "rev-004b",
      schemaHash: buildValidHash("schema-004b"),
      operationId: "op-004b",
      argumentsRedactedJson: { x: 2 },
    });
    expect(c1.callSequence).toBe(1);
    expect(c2.callSequence).toBe(2);
  });

  it("createToolCall：schemaHash 非法 → ToolCallValidationError", async () => {
    await expect(
      createToolCall({
        tenantId,
        invocationId: "inv-005",
        toolId: "tool-005",
        toolSchemaRevisionId: "rev-005",
        schemaHash: "not-a-hash",
        operationId: "op-005",
        argumentsRedactedJson: { x: 1 },
      }),
    ).rejects.toThrow(ToolCallValidationError);
  });

  it("createToolCall：缺 tenantId → ToolCallValidationError", async () => {
    await expect(
      createToolCall({
        tenantId: "",
        invocationId: "inv-006",
        toolId: "tool-006",
        toolSchemaRevisionId: "rev-006",
        schemaHash: buildValidHash("schema-006"),
        operationId: "op-006",
        argumentsRedactedJson: { x: 1 },
      }),
    ).rejects.toThrow(ToolCallValidationError);
  });

  it("createToolCall：缺 operationId → ToolCallValidationError", async () => {
    await expect(
      createToolCall({
        tenantId,
        invocationId: "inv-007",
        toolId: "tool-007",
        toolSchemaRevisionId: "rev-007",
        schemaHash: buildValidHash("schema-007"),
        operationId: "",
        argumentsRedactedJson: { x: 1 },
      }),
    ).rejects.toThrow(ToolCallValidationError);
  });
});

describe("V11 ToolCall 仓储：get / list 跨租户隔离", () => {
  let tenantId: string;
  let toolCallId: string;

  beforeEach(async () => {
    const seeded = await seedAdminWithCapabilityReviewBindings();
    tenantId = seeded.tenantId;
    const toolCall = await createToolCall({
      tenantId,
      invocationId: "inv-get-001",
      toolId: "tool-get-001",
      toolSchemaRevisionId: "rev-get-001",
      schemaHash: buildValidHash("schema-get-001"),
      operationId: "op-get-001",
      argumentsRedactedJson: { q: "x" },
    });
    toolCallId = toolCall.id;
  });

  it("getToolCallById 命中本租户 → 返回 ToolCall", async () => {
    const found = await getToolCallById({ tenantId, toolCallId });
    expect(found?.id).toBe(toolCallId);
  });

  it("getToolCallById 跨租户 → 返回 null", async () => {
    const found = await getToolCallById({
      tenantId: "11111111-1111-4111-8111-111111111111",
      toolCallId,
    });
    expect(found).toBeNull();
  });

  it("getToolCallById 不存在 → 返回 null", async () => {
    const found = await getToolCallById({
      tenantId,
      toolCallId: "99999999-9999-4999-8999-999999999999",
    });
    expect(found).toBeNull();
  });

  it("getToolCallByOperation 命中 → 返回 ToolCall", async () => {
    const found = await getToolCallByOperation({
      tenantId,
      toolId: "tool-get-001",
      operationId: "op-get-001",
    });
    expect(found?.id).toBe(toolCallId);
  });

  it("getToolCallByOperation 不存在 → 返回 null", async () => {
    const found = await getToolCallByOperation({
      tenantId,
      toolId: "tool-get-001",
      operationId: "non-existent-op",
    });
    expect(found).toBeNull();
  });

  it("listToolCallsByInvocation 按 callSequence 升序", async () => {
    await createToolCall({
      tenantId,
      invocationId: "inv-list-001",
      toolId: "tool-list-a",
      toolSchemaRevisionId: "rev-list-a",
      schemaHash: buildValidHash("schema-list-a"),
      operationId: "op-list-a",
      argumentsRedactedJson: { x: 1 },
    });
    await createToolCall({
      tenantId,
      invocationId: "inv-list-001",
      toolId: "tool-list-b",
      toolSchemaRevisionId: "rev-list-b",
      schemaHash: buildValidHash("schema-list-b"),
      operationId: "op-list-b",
      argumentsRedactedJson: { x: 2 },
    });
    const list = await listToolCallsByInvocation({
      tenantId,
      invocationId: "inv-list-001",
    });
    expect(list).toHaveLength(2);
    expect(list[0]?.callSequence).toBe(1);
    expect(list[1]?.callSequence).toBe(2);
  });
});

describe("V11 ToolCall 仓储：updateToolCallState 状态机", () => {
  let tenantId: string;
  let toolCallId: string;

  beforeEach(async () => {
    const seeded = await seedAdminWithCapabilityReviewBindings();
    tenantId = seeded.tenantId;
    const toolCall = await createToolCall({
      tenantId,
      invocationId: "inv-state-001",
      toolId: "tool-state-001",
      toolSchemaRevisionId: "rev-state-001",
      schemaHash: buildValidHash("schema-state-001"),
      operationId: "op-state-001",
      argumentsRedactedJson: { q: "x" },
    });
    toolCallId = toolCall.id;
  });

  it("proposed → running：startedAt 自动设置", async () => {
    const updated = await updateToolCallState({
      tenantId,
      toolCallId,
      toState: "running",
    });
    expect(updated.callState).toBe("running");
    expect(updated.startedAt).not.toBeNull();
  });

  it("running → succeeded：finishedAt 自动设置 + resultSummaryJson 透传", async () => {
    await updateToolCallState({ tenantId, toolCallId, toState: "running" });
    const updated = await updateToolCallState({
      tenantId,
      toolCallId,
      toState: "succeeded",
      resultSummaryJson: { ok: true, count: 42 },
    });
    expect(updated.callState).toBe("succeeded");
    expect(updated.finishedAt).not.toBeNull();
    expect(updated.resultSummaryJson).toEqual({ ok: true, count: 42 });
  });

  it("running → failed：errorCode + errorSummary 透传", async () => {
    await updateToolCallState({ tenantId, toolCallId, toState: "running" });
    const updated = await updateToolCallState({
      tenantId,
      toolCallId,
      toState: "failed",
      errorCode: "TOOL_EXEC_ERROR",
      errorSummary: "工具执行失败",
    });
    expect(updated.callState).toBe("failed");
    expect(updated.errorCode).toBe("TOOL_EXEC_ERROR");
    expect(updated.errorSummary).toBe("工具执行失败");
  });

  it("proposed → cancelled：合法迁移", async () => {
    const updated = await updateToolCallState({
      tenantId,
      toolCallId,
      toState: "cancelled",
    });
    expect(updated.callState).toBe("cancelled");
  });

  it("succeeded → running：终态再迁移 → ToolCallStateError", async () => {
    await updateToolCallState({ tenantId, toolCallId, toState: "running" });
    await updateToolCallState({ tenantId, toolCallId, toState: "succeeded" });
    await expect(updateToolCallState({ tenantId, toolCallId, toState: "running" })).rejects.toThrow(
      ToolCallStateError,
    );
  });

  it("proposed → succeeded：跳过 running → ToolCallStateError（非法迁移）", async () => {
    await expect(
      updateToolCallState({ tenantId, toolCallId, toState: "succeeded" }),
    ).rejects.toThrow(ToolCallStateError);
  });

  it("updateToolCallState：不存在/跨租户 → ToolCallNotFoundError", async () => {
    await expect(
      updateToolCallState({
        tenantId,
        toolCallId: "99999999-9999-4999-8999-999999999999",
        toState: "running",
      }),
    ).rejects.toThrow(ToolCallNotFoundError);
  });
});

// ═══════════════════════════════════════════════════════════
// 5. CapabilityReview 仓储：create / get / list / resolve
// ═══════════════════════════════════════════════════════════

describe("V11 CapabilityReview 仓储：createCapabilityReview", () => {
  let tenantId: string;

  beforeEach(async () => {
    const seeded = await seedAdminWithCapabilityReviewBindings();
    tenantId = seeded.tenantId;
  });

  it("createCapabilityReview 成功：默认 reviewState=pending, requiresReview 透传", async () => {
    const review = await createCapabilityReview({
      tenantId,
      resourceType: "tool",
      resourceId: "tool-review-001",
      oldRevisionId: "rev-old-001",
      newRevisionId: "rev-new-001",
      diffType: "read_to_write",
      requiresReview: true,
      description: "effect 从 read_only 升级到 write",
      affectedAgents: ["agent-001", "agent-002"],
    });
    expect(review.id).toEqual(expect.any(String));
    expect(review.tenantId).toBe(tenantId);
    expect(review.resourceType).toBe("tool");
    expect(review.resourceId).toBe("tool-review-001");
    expect(review.oldRevisionId).toBe("rev-old-001");
    expect(review.newRevisionId).toBe("rev-new-001");
    expect(review.diffType).toBe("read_to_write");
    expect(review.requiresReview).toBe(true);
    expect(review.reviewState).toBe("pending");
    expect(review.affectedAgentsJson).toEqual(["agent-001", "agent-002"]);
    expect(review.reviewedBy).toBeNull();
    expect(review.reviewedAt).toBeNull();
  });

  it("createCapabilityReview：oldRevisionId=null（首次发布）", async () => {
    const review = await createCapabilityReview({
      tenantId,
      resourceType: "skill",
      resourceId: "skill-001",
      oldRevisionId: null,
      newRevisionId: "rev-new-skill-001",
      diffType: "env_test_to_prod",
      requiresReview: true,
      description: "首次发布到 prod",
      affectedAgents: [],
    });
    expect(review.oldRevisionId).toBeNull();
    expect(review.resourceType).toBe("skill");
  });

  it("createCapabilityReview：resourceType 非法 → CapabilityReviewValidationError", async () => {
    await expect(
      createCapabilityReview({
        tenantId,
        resourceType: "invalid" as "tool",
        resourceId: "x",
        newRevisionId: "rev-x",
        diffType: "no_change",
        requiresReview: false,
        description: "x",
        affectedAgents: [],
      }),
    ).rejects.toThrow(CapabilityReviewValidationError);
  });

  it("createCapabilityReview：description 为空 → CapabilityReviewValidationError", async () => {
    await expect(
      createCapabilityReview({
        tenantId,
        resourceType: "tool",
        resourceId: "x",
        newRevisionId: "rev-x",
        diffType: "no_change",
        requiresReview: false,
        description: "   ",
        affectedAgents: [],
      }),
    ).rejects.toThrow(CapabilityReviewValidationError);
  });

  it("createCapabilityReview：affectedAgents 含非字符串 → CapabilityReviewValidationError", async () => {
    await expect(
      createCapabilityReview({
        tenantId,
        resourceType: "tool",
        resourceId: "x",
        newRevisionId: "rev-x",
        diffType: "no_change",
        requiresReview: false,
        description: "valid",
        affectedAgents: ["ok", 123 as unknown as string],
      }),
    ).rejects.toThrow(CapabilityReviewValidationError);
  });
});

describe("V11 CapabilityReview 仓储：get / list 跨租户隔离", () => {
  let tenantId: string;
  let reviewId: string;

  beforeEach(async () => {
    const seeded = await seedAdminWithCapabilityReviewBindings();
    tenantId = seeded.tenantId;
    const review = await createCapabilityReview({
      tenantId,
      resourceType: "tool",
      resourceId: "tool-list-001",
      newRevisionId: "rev-list-001",
      diffType: "read_to_write",
      requiresReview: true,
      description: "差异描述",
      affectedAgents: ["agent-001"],
    });
    reviewId = review.id;
  });

  it("getCapabilityReviewById 命中本租户 → 返回 review", async () => {
    const found = await getCapabilityReviewById({ tenantId, reviewId });
    expect(found?.id).toBe(reviewId);
  });

  it("getCapabilityReviewById 跨租户 → 返回 null", async () => {
    const found = await getCapabilityReviewById({
      tenantId: "11111111-1111-4111-8111-111111111111",
      reviewId,
    });
    expect(found).toBeNull();
  });

  it("listPendingReviews：默认只返回 pending", async () => {
    // 再创建一条 approved 的记录
    const otherReview = await createCapabilityReview({
      tenantId,
      resourceType: "tool",
      resourceId: "tool-list-002",
      newRevisionId: "rev-list-002",
      diffType: "no_change",
      requiresReview: false,
      description: "兼容性变更",
      affectedAgents: [],
    });
    await resolveCapabilityReview({
      tenantId,
      reviewId: otherReview.id,
      toState: "approved",
      reviewedBy: "user-001",
    });

    const { items } = await listPendingReviews({ tenantId });
    // 默认只返回 pending：包含最初的 review，不包含 approved 的 otherReview
    expect(items.some((r) => r.id === reviewId)).toBe(true);
    expect(items.some((r) => r.id === otherReview.id)).toBe(false);
  });

  it("listPendingReviews：按 reviewState=approved 过滤", async () => {
    const otherReview = await createCapabilityReview({
      tenantId,
      resourceType: "tool",
      resourceId: "tool-list-003",
      newRevisionId: "rev-list-003",
      diffType: "no_change",
      requiresReview: false,
      description: "兼容性变更",
      affectedAgents: [],
    });
    await resolveCapabilityReview({
      tenantId,
      reviewId: otherReview.id,
      toState: "approved",
      reviewedBy: "user-001",
    });

    const { items } = await listPendingReviews({
      tenantId,
      reviewState: "approved",
    });
    expect(items.some((r) => r.id === otherReview.id)).toBe(true);
    expect(items.some((r) => r.id === reviewId)).toBe(false);
  });

  it("listPendingReviews：按 resourceType 过滤", async () => {
    await createCapabilityReview({
      tenantId,
      resourceType: "skill",
      resourceId: "skill-list-001",
      newRevisionId: "rev-skill-list-001",
      diffType: "no_change",
      requiresReview: false,
      description: "skill 变更",
      affectedAgents: [],
    });

    const { items: toolItems } = await listPendingReviews({
      tenantId,
      resourceType: "tool",
    });
    const { items: skillItems } = await listPendingReviews({
      tenantId,
      resourceType: "skill",
    });
    expect(toolItems.every((r) => r.resourceType === "tool")).toBe(true);
    expect(skillItems.every((r) => r.resourceType === "skill")).toBe(true);
  });
});

describe("V11 CapabilityReview 仓储：resolveCapabilityReview 状态机", () => {
  let tenantId: string;
  let reviewId: string;

  beforeEach(async () => {
    const seeded = await seedAdminWithCapabilityReviewBindings();
    tenantId = seeded.tenantId;
    const review = await createCapabilityReview({
      tenantId,
      resourceType: "tool",
      resourceId: "tool-resolve-001",
      newRevisionId: "rev-resolve-001",
      diffType: "read_to_write",
      requiresReview: true,
      description: "差异描述",
      affectedAgents: ["agent-001"],
    });
    reviewId = review.id;
  });

  it("pending → approved：reviewedBy / reviewedAt / reviewNotes 透传", async () => {
    const updated = await resolveCapabilityReview({
      tenantId,
      reviewId,
      toState: "approved",
      reviewedBy: "user-001",
      reviewNotes: "已确认安全",
    });
    expect(updated.reviewState).toBe("approved");
    expect(updated.reviewedBy).toBe("user-001");
    expect(updated.reviewedAt).not.toBeNull();
    expect(updated.reviewNotes).toBe("已确认安全");
  });

  it("pending → rejected：合法迁移", async () => {
    const updated = await resolveCapabilityReview({
      tenantId,
      reviewId,
      toState: "rejected",
      reviewedBy: "user-002",
      reviewNotes: "拒绝：风险过高",
    });
    expect(updated.reviewState).toBe("rejected");
    expect(updated.reviewedBy).toBe("user-002");
  });

  it("approved → rejected：终态再迁移 → CapabilityReviewStateError", async () => {
    await resolveCapabilityReview({
      tenantId,
      reviewId,
      toState: "approved",
      reviewedBy: "user-001",
    });
    await expect(
      resolveCapabilityReview({
        tenantId,
        reviewId,
        toState: "rejected",
        reviewedBy: "user-001",
      }),
    ).rejects.toThrow(CapabilityReviewStateError);
  });

  it("resolveCapabilityReview：同状态幂等（approved → approved 补充 notes）", async () => {
    await resolveCapabilityReview({
      tenantId,
      reviewId,
      toState: "approved",
      reviewedBy: "user-001",
      reviewNotes: "首次备注",
    });
    const updated = await resolveCapabilityReview({
      tenantId,
      reviewId,
      toState: "approved",
      reviewedBy: "user-001",
      reviewNotes: "补充备注",
    });
    expect(updated.reviewState).toBe("approved");
    expect(updated.reviewNotes).toBe("补充备注");
  });

  it("resolveCapabilityReview：不存在/跨租户 → CapabilityReviewNotFoundError", async () => {
    await expect(
      resolveCapabilityReview({
        tenantId,
        reviewId: "99999999-9999-4999-8999-999999999999",
        toState: "approved",
        reviewedBy: "user-001",
      }),
    ).rejects.toThrow(CapabilityReviewNotFoundError);
  });

  it("resolveCapabilityReview：缺 reviewedBy → CapabilityReviewValidationError", async () => {
    await expect(
      resolveCapabilityReview({
        tenantId,
        reviewId,
        toState: "approved",
        reviewedBy: "",
      }),
    ).rejects.toThrow(CapabilityReviewValidationError);
  });
});

// ═══════════════════════════════════════════════════════════
// 6. Admin API: POST /capability-reviews + GET /capability-reviews
// ═══════════════════════════════════════════════════════════

describe("POST /admin/api/v1/capability-reviews", () => {
  beforeEach(async () => {
    await seedAdminWithCapabilityReviewBindings();
  });

  it("成功创建（route 内部计算 diff）→ 201", async () => {
    const request = buildV11Request({
      audience: "admin",
      method: "POST",
      path: "/capability-reviews",
      idempotencyKey: "idem-create-review-001",
      body: {
        resource_type: "tool",
        resource_id: "tool-api-001",
        old_revision_id: "rev-old-api-001",
        new_revision_id: "rev-new-api-001",
        old_risk_metadata: { effect: "read_only" },
        new_risk_metadata: { effect: "write" },
        affected_agents: ["agent-001"],
      },
    });

    const response = await createReviewPOST(request);
    expect(response.status).toBe(201);
    const body = (await response.json()) as Record<string, unknown>;
    expect(body.resource_type).toBe("tool");
    expect(body.resource_id).toBe("tool-api-001");
    expect(body.diff_type).toBe("read_to_write");
    expect(body.requires_review).toBe(true);
    expect(body.review_state).toBe("pending");
    expect(body.affected_agents).toEqual(["agent-001"]);
  });

  it("成功创建（调用方直接传 risk_diff）→ 201", async () => {
    const request = buildV11Request({
      audience: "admin",
      method: "POST",
      path: "/capability-reviews",
      idempotencyKey: "idem-create-review-002",
      body: {
        resource_type: "tool",
        resource_id: "tool-api-002",
        new_revision_id: "rev-new-api-002",
        risk_diff: {
          diff_type: "no_change",
          requires_review: false,
          description: "无变化",
        },
      },
    });

    const response = await createReviewPOST(request);
    expect(response.status).toBe(201);
    const body = (await response.json()) as Record<string, unknown>;
    expect(body.diff_type).toBe("no_change");
    expect(body.requires_review).toBe(false);
  });

  it("缺少 Idempotency-Key → 400 REQUEST_SCHEMA_INVALID", async () => {
    const request = buildV11Request({
      audience: "admin",
      method: "POST",
      path: "/capability-reviews",
      body: {
        resource_type: "tool",
        resource_id: "tool-api-no-idem",
        new_revision_id: "rev-no-idem",
        risk_diff: {
          diff_type: "no_change",
          requires_review: false,
          description: "x",
        },
      },
    });

    const response = await createReviewPOST(request);
    expect(response.status).toBe(400);
    const body = (await response.json()) as { error: { code: string } };
    expect(body.error.code).toBe("REQUEST_SCHEMA_INVALID");
  });

  it("请求体非法（缺 resource_type）→ 400 REQUEST_SCHEMA_INVALID", async () => {
    const request = buildV11Request({
      audience: "admin",
      method: "POST",
      path: "/capability-reviews",
      idempotencyKey: "idem-bad-body-001",
      body: {
        resource_id: "x",
        new_revision_id: "y",
        risk_diff: {
          diff_type: "no_change",
          requires_review: false,
          description: "x",
        },
      },
    });

    const response = await createReviewPOST(request);
    expect(response.status).toBe(400);
    const body = (await response.json()) as { error: { code: string } };
    expect(body.error.code).toBe("REQUEST_SCHEMA_INVALID");
  });

  it("缺少 risk_diff 且缺少 new_risk_metadata → 400 REQUEST_SCHEMA_INVALID", async () => {
    const request = buildV11Request({
      audience: "admin",
      method: "POST",
      path: "/capability-reviews",
      idempotencyKey: "idem-no-diff-001",
      body: {
        resource_type: "tool",
        resource_id: "tool-no-diff",
        new_revision_id: "rev-no-diff",
      },
    });

    const response = await createReviewPOST(request);
    expect(response.status).toBe(400);
    const body = (await response.json()) as { error: { code: string } };
    expect(body.error.code).toBe("REQUEST_SCHEMA_INVALID");
  });

  it("同 Idempotency-Key 重放 → 409 IDEMPOTENCY_CONFLICT", async () => {
    const body = {
      resource_type: "tool" as const,
      resource_id: "tool-replay",
      new_revision_id: "rev-replay",
      risk_diff: {
        diff_type: "no_change",
        requires_review: false,
        description: "x",
      },
    };
    const request1 = buildV11Request({
      audience: "admin",
      method: "POST",
      path: "/capability-reviews",
      idempotencyKey: "idem-replay-001",
      body,
    });
    const response1 = await createReviewPOST(request1);
    expect(response1.status).toBe(201);

    // 同 Idempotency-Key 不同 body → 冲突
    const request2 = buildV11Request({
      audience: "admin",
      method: "POST",
      path: "/capability-reviews",
      idempotencyKey: "idem-replay-001",
      body: { ...body, resource_id: "tool-replay-2" },
    });
    const response2 = await createReviewPOST(request2);
    expect(response2.status).toBe(409);
    const errBody = (await response2.json()) as { error: { code: string } };
    expect(errBody.error.code).toBe("IDEMPOTENCY_CONFLICT");
  });
});

describe("GET /admin/api/v1/capability-reviews", () => {
  let tenantId: string;
  let reviewId: string;

  beforeEach(async () => {
    const seeded = await seedAdminWithCapabilityReviewBindings();
    tenantId = seeded.tenantId;
    const review = await createCapabilityReview({
      tenantId,
      resourceType: "tool",
      resourceId: "tool-get-list-001",
      newRevisionId: "rev-get-list-001",
      diffType: "read_to_write",
      requiresReview: true,
      description: "差异",
      affectedAgents: [],
    });
    reviewId = review.id;
  });

  it("GET /capability-reviews 成功 → 200 + items", async () => {
    const request = buildV11Request({
      audience: "admin",
      method: "GET",
      path: "/capability-reviews",
    });
    const response = await listReviewsGET(request);
    expect(response.status).toBe(200);
    const body = (await response.json()) as {
      items: Array<{ id: string }>;
      next_cursor: string | null;
    };
    expect(body.items.some((r) => r.id === reviewId)).toBe(true);
  });

  it("GET /capability-reviews?review_state=approved → 200 + 空列表（无 approved 记录）", async () => {
    const request = buildV11Request({
      audience: "admin",
      method: "GET",
      path: "/capability-reviews?review_state=approved",
    });
    const response = await listReviewsGET(request);
    expect(response.status).toBe(200);
    const body = (await response.json()) as { items: unknown[] };
    expect(body.items).toHaveLength(0);
  });

  it("GET /capability-reviews?resource_type=invalid → 400 REQUEST_SCHEMA_INVALID", async () => {
    const request = buildV11Request({
      audience: "admin",
      method: "GET",
      path: "/capability-reviews?resource_type=invalid",
    });
    const response = await listReviewsGET(request);
    expect(response.status).toBe(400);
    const body = (await response.json()) as { error: { code: string } };
    expect(body.error.code).toBe("REQUEST_SCHEMA_INVALID");
  });
});

// ═══════════════════════════════════════════════════════════
// 7. Admin API: GET / POST /capability-reviews/{review_id}
// ═══════════════════════════════════════════════════════════

describe("GET / POST /admin/api/v1/capability-reviews/{review_id}", () => {
  let tenantId: string;
  let userIdentityId: string;
  let reviewId: string;

  beforeEach(async () => {
    const seeded = await seedAdminWithCapabilityReviewBindings();
    tenantId = seeded.tenantId;
    userIdentityId = seeded.userIdentityId;
    const review = await createCapabilityReview({
      tenantId,
      resourceType: "tool",
      resourceId: "tool-single-001",
      newRevisionId: "rev-single-001",
      diffType: "read_to_write",
      requiresReview: true,
      description: "差异",
      affectedAgents: ["agent-001"],
    });
    reviewId = review.id;
  });

  it("GET /capability-reviews/{id} 成功 → 200", async () => {
    const request = buildV11Request({
      audience: "admin",
      method: "GET",
      path: `/capability-reviews/${reviewId}`,
    });
    const response = await getReviewGET(request, {
      params: Promise.resolve({ review_id: reviewId }),
    });
    expect(response.status).toBe(200);
    const body = (await response.json()) as Record<string, unknown>;
    expect(body.id).toBe(reviewId);
    expect(body.resource_type).toBe("tool");
    expect(body.review_state).toBe("pending");
  });

  it("GET /capability-reviews/{id} 不存在 → 404 RESOURCE_NOT_FOUND", async () => {
    const randomId = "99999999-9999-4999-8999-999999999999";
    const requestId = "req-review-not-found";
    const request = buildV11Request({
      audience: "admin",
      method: "GET",
      path: `/capability-reviews/${randomId}`,
      requestId,
    });
    const response = await getReviewGET(request, {
      params: Promise.resolve({ review_id: randomId }),
    });
    await assertCrossTenantHidden(response, requestId);
  });

  it("POST /capability-reviews/{id} 审核 approved → 200 + review_state=approved", async () => {
    const request = buildV11Request({
      audience: "admin",
      method: "POST",
      path: `/capability-reviews/${reviewId}`,
      idempotencyKey: "idem-resolve-001",
      body: {
        decision: "approved",
        review_notes: "已审核通过",
      },
    });
    const response = await resolveReviewPOST(request, {
      params: Promise.resolve({ review_id: reviewId }),
    });
    expect(response.status).toBe(200);
    const body = (await response.json()) as Record<string, unknown>;
    expect(body.review_state).toBe("approved");
    expect(body.reviewed_by).toBe(userIdentityId);
    expect(body.review_notes).toBe("已审核通过");
  });

  it("POST /capability-reviews/{id} 审核 rejected → 200 + review_state=rejected", async () => {
    const request = buildV11Request({
      audience: "admin",
      method: "POST",
      path: `/capability-reviews/${reviewId}`,
      idempotencyKey: "idem-resolve-002",
      body: {
        decision: "rejected",
        review_notes: "拒绝：风险过高",
      },
    });
    const response = await resolveReviewPOST(request, {
      params: Promise.resolve({ review_id: reviewId }),
    });
    expect(response.status).toBe(200);
    const body = (await response.json()) as Record<string, unknown>;
    expect(body.review_state).toBe("rejected");
  });

  it("POST /capability-reviews/{id} 缺 Idempotency-Key → 400 REQUEST_SCHEMA_INVALID", async () => {
    const request = buildV11Request({
      audience: "admin",
      method: "POST",
      path: `/capability-reviews/${reviewId}`,
      body: { decision: "approved" },
    });
    const response = await resolveReviewPOST(request, {
      params: Promise.resolve({ review_id: reviewId }),
    });
    expect(response.status).toBe(400);
    const body = (await response.json()) as { error: { code: string } };
    expect(body.error.code).toBe("REQUEST_SCHEMA_INVALID");
  });

  it("POST /capability-reviews/{id} 请求体非法（decision 缺失）→ 400", async () => {
    const request = buildV11Request({
      audience: "admin",
      method: "POST",
      path: `/capability-reviews/${reviewId}`,
      idempotencyKey: "idem-bad-decision-001",
      body: { review_notes: "no decision" },
    });
    const response = await resolveReviewPOST(request, {
      params: Promise.resolve({ review_id: reviewId }),
    });
    expect(response.status).toBe(400);
    const body = (await response.json()) as { error: { code: string } };
    expect(body.error.code).toBe("REQUEST_SCHEMA_INVALID");
  });

  it("POST /capability-reviews/{id} 终态再迁移 → 422 BUSINESS_CONSTRAINT_VIOLATION", async () => {
    // 先 approved
    const approveReq = buildV11Request({
      audience: "admin",
      method: "POST",
      path: `/capability-reviews/${reviewId}`,
      idempotencyKey: "idem-approve-first",
      body: { decision: "approved" },
    });
    await resolveReviewPOST(approveReq, {
      params: Promise.resolve({ review_id: reviewId }),
    });

    // 再尝试 rejected → 终态迁移冲突
    const rejectReq = buildV11Request({
      audience: "admin",
      method: "POST",
      path: `/capability-reviews/${reviewId}`,
      idempotencyKey: "idem-reject-after-approve",
      body: { decision: "rejected" },
    });
    const response = await resolveReviewPOST(rejectReq, {
      params: Promise.resolve({ review_id: reviewId }),
    });
    expect(response.status).toBe(422);
    const body = (await response.json()) as { error: { code: string } };
    expect(body.error.code).toBe("BUSINESS_CONSTRAINT_VIOLATION");
  });
});
