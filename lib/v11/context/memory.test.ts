/**
 * V11 Memory Candidate / Policy / Entry 集成测试（阶段 7 S07-C03 / S07-C04）。
 *
 * 事实源：
 * - ../v11-agentkit-platform/03-context-memory-and-knowledge.md §8（作用域）、§9（挂载与检索）、§10（写入路径）、§11（禁止内容与用户控制）。
 * - ../v11-agentkit-platform/10-core-data-model.md §7.5（memory_candidate / memory_entry / memory_source）。
 * - ../v11-agentkit-platform/13-memory-and-job-api.md §2（Memory Candidate API）。
 *
 * 覆盖：
 * - memory-queries：computeCandidateKey / detectSensitiveContent / evaluateMemoryPolicy /
 *   isScopeNarrowingValid / isReviewableScopeType / deriveSourceFromCandidate /
 *   createMemoryCandidateWithEntry / insertMemoryCandidate（rejected 销毁正文） / resolveMemoryCandidate。
 * - S07-C04：computeMemoryEntryKey / listActiveMemoryEntriesByScopes / listMemoryEntriesByScope /
 *   archiveMemoryEntry / updateMemoryEntry / migrateThreadPinnedFacts。
 * - POST /gateway/v1/memory-candidates：鉴权 / 请求体校验 / content_hash 不一致 /
 *   accepted / rejected / needs_review 三态 / 幂等重放 / 幂等冲突 / candidate_key 去重 / 跨租户隔离。
 * - GET /gateway/v1/memory-candidates/{id}：跨 invocation 隔离 / 成功查询。
 * - POST /admin/api/v1/memory-candidates/{id}:resolve：鉴权 / action scope / scope 收窄 /
 *   accept / reject / MEMORY_CANDIDATE_ALREADY_RESOLVED / 幂等重放。
 * - S07-C04 Employee API：GET /api/v1/memory-entries（列表）/ GET/PATCH/DELETE /api/v1/memory-entries/{id}。
 * - S07-C04 MemoryResolver：分作用域检索 + restricted 不返回正文。
 *
 * 真实 MySQL 8 Testcontainers，不使用 mock。Gateway Token 由 issueWorkloadToken 构造。
 */
import { randomUUID } from "node:crypto";
import { memoryCandidateResolvePOST } from "@/app/admin/api/v1/memory-candidates/[candidate_id]:resolve/route";
import {
  DELETE as memoryEntryDELETE,
  GET as memoryEntryGET,
  PATCH as memoryEntryPATCH,
} from "@/app/api/v1/memory-entries/[entry_id]/route";
import { GET as memoryEntryListGET } from "@/app/api/v1/memory-entries/route";
import { memoryCandidateGET } from "@/app/gateway/v1/memory-candidates/[candidate_id]/route";
import { memoryCandidatePOST } from "@/app/gateway/v1/memory-candidates/route";
import { DEFAULT_USER_EMAIL, DEFAULT_USER_ID, DEFAULT_USER_NAME } from "@/lib/constants";
import { db } from "@/lib/db/client";
import { buildV11Request, withRollback } from "@/lib/db/test/api-fixtures";
import { resetDatabase } from "@/lib/db/test/mysql-harness";
import {
  MemoryCandidateAlreadyResolvedError,
  archiveMemoryEntry,
  computeCandidateKey,
  computeMemoryContentHash,
  computeMemoryEntryKey,
  createMemoryCandidateWithEntry,
  deriveSourceFromCandidate,
  detectSensitiveContent,
  evaluateMemoryPolicy,
  getMemoryCandidateById,
  getMemoryEntryById,
  insertMemoryCandidate,
  isReviewableScopeType,
  isScopeNarrowingValid,
  listActiveMemoryEntriesByScopes,
  listMemoryEntriesByScope,
  migrateThreadPinnedFacts,
  resolveMemoryCandidate,
  updateMemoryEntry,
} from "@/lib/v11/context/memory-queries";
import { MemoryResolver } from "@/lib/v11/context/source-resolvers";
import { upsertPrincipalBinding } from "@/lib/v11/identity/principal-binding-queries";
import { grantActionBinding } from "@/lib/v11/identity/role-action-queries";
import { ensureDefaultTenant } from "@/lib/v11/identity/tenant-queries";
import { upsertUserIdentity } from "@/lib/v11/identity/user-identity-queries";
import { type WorkloadTokenClaims, issueWorkloadToken } from "@/lib/v11/identity/workload-token";
import { tenant as tenantTable } from "@/lib/v11/schema/identity";
import { memoryCandidate, memoryEntry, memorySource } from "@/lib/v11/schema/memory";
import { eq } from "drizzle-orm";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

const ORIGINAL_AUTH_MODE = process.env.SNOW_AUTH_MODE;

beforeEach(async () => {
  process.env.SNOW_AUTH_MODE = "dev";
  await resetDatabase(db);
});

afterEach(() => {
  process.env.SNOW_AUTH_MODE = ORIGINAL_AUTH_MODE;
});

// ─── 辅助：seed 默认租户 + 用户身份 + 主体绑定 ────────────────

async function seedContext() {
  const t = await ensureDefaultTenant();
  const identity = await upsertUserIdentity({
    tenantId: t.id,
    externalSubject: DEFAULT_USER_ID,
    email: DEFAULT_USER_EMAIL,
    displayName: DEFAULT_USER_NAME,
  });
  const binding = await upsertPrincipalBinding({
    tenantId: t.id,
    subjectType: "user",
    externalId: DEFAULT_USER_ID,
    displayName: DEFAULT_USER_NAME,
    userIdentityId: identity.id,
  });
  return { tenantId: t.id, userIdentityId: identity.id, principalBindingId: binding.id };
}

/** 构造 Gateway Workload Token。 */
function makeGatewayToken(
  tenantId: string,
  invocationId: string,
  overrides: Partial<Omit<WorkloadTokenClaims, "issuedAt">> = {},
): string {
  const claims: Omit<WorkloadTokenClaims, "issuedAt"> = {
    type: "gateway",
    tenantId,
    jti: "jti-gateway-memory-001",
    invocationId,
    audience: "gateway",
    expiresAt: Date.now() + 60_000,
    ...overrides,
  };
  return issueWorkloadToken(claims);
}

/** 构造合法请求体。 */
function makeBody(overrides?: Record<string, unknown>): Record<string, unknown> {
  const text = "用户偏好：使用中文回复，并优先展示代码示例。";
  return {
    invocation_id: "inv_mem_001",
    source: {
      thread_id: "thread_001",
      turn_id: "turn_001",
      item_id: "item_001",
      hash: computeMemoryContentHash(text),
    },
    proposed_scope: {
      type: "workspace",
      ref: "ws_001",
    },
    memory_type: "preference",
    content: { text },
    content_hash: computeMemoryContentHash(text),
    sensitivity_class: "internal",
    rationale_code: "USER_EXPLICIT",
    ...overrides,
  };
}

/** 清理 candidate + entry + source 行（按 tenantId 范围）。 */
async function cleanupTenantMemory(tenantId: string) {
  // 删除 memory_source（依赖 entry，先查 entries）
  const entries = await db
    .select({ id: memoryEntry.id })
    .from(memoryEntry)
    .where(eq(memoryEntry.tenantId, tenantId));
  for (const e of entries) {
    await db.delete(memorySource).where(eq(memorySource.memoryEntryId, e.id));
  }
  await db.delete(memoryCandidate).where(eq(memoryCandidate.tenantId, tenantId));
  await db.delete(memoryEntry).where(eq(memoryEntry.tenantId, tenantId));
}

// ═══════════════════════════════════════════════════════════
// 1. memory-queries：纯逻辑与 DB 集成
// ═══════════════════════════════════════════════════════════

describe("memory-queries：Hash / Key 计算", () => {
  it("computeMemoryContentHash：返回 sha256: 前缀 + 64 hex", () => {
    const hash = computeMemoryContentHash("测试内容");
    expect(hash).toMatch(/^sha256:[0-9a-f]{64}$/);
  });

  it("computeCandidateKey：返回 sha256: 前缀 + 64 hex", () => {
    const key = computeCandidateKey({
      invocationId: "inv_001",
      sourceType: "thread_item",
      sourceId: "item_001",
      contentHash: `sha256:${"a".repeat(64)}`,
      scopeType: "workspace",
      scopeRef: "ws_001",
    });
    expect(key).toMatch(/^sha256:[0-9a-f]{64}$/);
  });

  it("computeCandidateKey：相同字段产生相同 key", () => {
    const params = {
      invocationId: "inv_001",
      sourceType: "thread_item" as const,
      sourceId: "item_001",
      contentHash: `sha256:${"a".repeat(64)}`,
      scopeType: "workspace" as const,
      scopeRef: "ws_001",
    };
    expect(computeCandidateKey(params)).toBe(computeCandidateKey(params));
  });

  it("computeCandidateKey：scope_ref null 与空字符串等价", () => {
    const base = {
      invocationId: "inv_001",
      sourceType: "thread_item" as const,
      sourceId: "item_001",
      contentHash: `sha256:${"a".repeat(64)}`,
      scopeType: "workspace" as const,
    };
    const keyNull = computeCandidateKey({ ...base, scopeRef: null });
    const keyEmpty = computeCandidateKey({ ...base, scopeRef: "" });
    const keyUndefined = computeCandidateKey({ ...base });
    expect(keyNull).toBe(keyEmpty);
    expect(keyNull).toBe(keyUndefined);
  });

  it("computeCandidateKey：不同字段产生不同 key", () => {
    const base = {
      invocationId: "inv_001",
      sourceType: "thread_item" as const,
      sourceId: "item_001",
      contentHash: `sha256:${"a".repeat(64)}`,
      scopeType: "workspace" as const,
      scopeRef: "ws_001",
    };
    expect(computeCandidateKey({ ...base, invocationId: "inv_002" })).not.toBe(
      computeCandidateKey(base),
    );
    expect(computeCandidateKey({ ...base, scopeType: "agent" })).not.toBe(
      computeCandidateKey(base),
    );
  });
});

describe("memory-queries：deriveSourceFromCandidate", () => {
  it("item_id 非空 → thread_item", () => {
    const r = deriveSourceFromCandidate({ sourceItemId: "i1" });
    expect(r).toEqual({ sourceType: "thread_item", sourceId: "i1" });
  });

  it("job_id 非空 → job", () => {
    const r = deriveSourceFromCandidate({ sourceJobId: "j1" });
    expect(r).toEqual({ sourceType: "job", sourceId: "j1" });
  });

  it("artifact_id 非空 → artifact", () => {
    const r = deriveSourceFromCandidate({ sourceArtifactId: "a1" });
    expect(r).toEqual({ sourceType: "artifact", sourceId: "a1" });
  });

  it("三个字段都为空 → 抛错", () => {
    expect(() => deriveSourceFromCandidate({})).toThrow();
  });

  it("多个字段非空 → 抛错", () => {
    expect(() => deriveSourceFromCandidate({ sourceItemId: "i1", sourceJobId: "j1" })).toThrow();
  });
});

describe("memory-queries：detectSensitiveContent", () => {
  it("PEM 私钥命中", () => {
    expect(detectSensitiveContent("-----BEGIN RSA PRIVATE KEY-----\nMIIEowIBAAKCAQEA...")).toBe(
      true,
    );
  });

  it("AWS Access Key ID 命中", () => {
    expect(detectSensitiveContent("AKIAIOSFODNN7EXAMPLE12345")).toBe(true);
  });

  it("Bearer Token 命中", () => {
    expect(detectSensitiveContent("Authorization: Bearer abcdef1234567890")).toBe(true);
  });

  it("JWT 命中", () => {
    expect(
      detectSensitiveContent(
        "eyJhbGciOiJIUzI1NiJ9.eyJzdWIiOiIxMjM0NTY3ODkwIn0.SflKxwRJSMeKKF2QT4fwpMeJf36POk6yJV_adQssw5c",
      ),
    ).toBe(true);
  });

  it("password= 命中", () => {
    expect(detectSensitiveContent("password=admin1234")).toBe(true);
  });

  it("cookie= 命中", () => {
    expect(detectSensitiveContent("cookie=sessionid=abcdef1234567890")).toBe(true);
  });

  it("api_key= 命中", () => {
    expect(detectSensitiveContent("api_key=sk-abcdefghijklmnopqrstuvwxyz123456")).toBe(true);
  });

  it("无敏感内容 → false", () => {
    expect(detectSensitiveContent("用户偏好：使用中文回复")).toBe(false);
    expect(detectSensitiveContent("")).toBe(false);
  });
});

describe("memory-queries：evaluateMemoryPolicy", () => {
  it("敏感内容 → rejected + sensitive_content_detected", () => {
    const r = evaluateMemoryPolicy({
      contentRedacted: "Bearer abcdef1234567890",
      proposedScopeType: "workspace",
      sensitivityClass: "internal",
    });
    expect(r.decision).toBe("rejected");
    expect(r.reasonCodes).toContain("sensitive_content_detected");
  });

  it("organization scope → needs_review + organization_scope_requires_review", () => {
    const r = evaluateMemoryPolicy({
      contentRedacted: "组织级偏好",
      proposedScopeType: "organization",
      sensitivityClass: "public",
    });
    expect(r.decision).toBe("needs_review");
    expect(r.reasonCodes).toContain("organization_scope_requires_review");
  });

  it("workspace scope + 普通内容 → accepted", () => {
    const r = evaluateMemoryPolicy({
      contentRedacted: "工作空间偏好",
      proposedScopeType: "workspace",
      sensitivityClass: "internal",
    });
    expect(r.decision).toBe("accepted");
    expect(r.reasonCodes).toHaveLength(0);
  });

  it("restricted sensitivity 不再触发 needs_review（仅影响检索过滤）", () => {
    const r = evaluateMemoryPolicy({
      contentRedacted: "受限偏好",
      proposedScopeType: "workspace",
      sensitivityClass: "restricted",
    });
    expect(r.decision).toBe("accepted");
    expect(r.reasonCodes).toHaveLength(0);
  });

  it("organization scope + 敏感内容 → rejected 优先于 needs_review", () => {
    const r = evaluateMemoryPolicy({
      contentRedacted: "password=admin1234",
      proposedScopeType: "organization",
      sensitivityClass: "public",
    });
    expect(r.decision).toBe("rejected");
    expect(r.reasonCodes).toContain("sensitive_content_detected");
  });

  it("content_ref only（无正文）+ organization → needs_review", () => {
    const r = evaluateMemoryPolicy({
      contentRedacted: null,
      proposedScopeType: "organization",
      sensitivityClass: "public",
    });
    expect(r.decision).toBe("needs_review");
  });
});

describe("memory-queries：isScopeNarrowingValid / isReviewableScopeType", () => {
  it("isScopeNarrowingValid：organization → workspace 合法", () => {
    expect(isScopeNarrowingValid("organization", "workspace")).toBe(true);
  });

  it("isScopeNarrowingValid：workspace → organization 非法（扩大）", () => {
    expect(isScopeNarrowingValid("workspace", "organization")).toBe(false);
  });

  it("isScopeNarrowingValid：同 scope 合法", () => {
    expect(isScopeNarrowingValid("workspace", "workspace")).toBe(true);
    expect(isScopeNarrowingValid("organization", "organization")).toBe(true);
  });

  it("isScopeNarrowingValid：workspace → agent 合法", () => {
    expect(isScopeNarrowingValid("workspace", "agent")).toBe(true);
  });

  it("isScopeNarrowingValid：agent → workspace 非法（扩大）", () => {
    expect(isScopeNarrowingValid("agent", "workspace")).toBe(false);
  });

  it("isReviewableScopeType：workspace / agent / organization → true", () => {
    expect(isReviewableScopeType("workspace")).toBe(true);
    expect(isReviewableScopeType("agent")).toBe(true);
    expect(isReviewableScopeType("organization")).toBe(true);
  });

  it("isReviewableScopeType：thread / user_preference → false", () => {
    expect(isReviewableScopeType("thread")).toBe(false);
    expect(isReviewableScopeType("user_preference")).toBe(false);
  });
});

describe("memory-queries：createMemoryCandidateWithEntry / insertMemoryCandidate（DB）", () => {
  it("createMemoryCandidateWithEntry：accepted 路径同事务写 candidate + entry + source", async () => {
    const { tenantId } = await seedContext();
    try {
      const content = "工作空间偏好";
      const contentHash = computeMemoryContentHash(content);
      const candidateKey = computeCandidateKey({
        invocationId: "inv_create_001",
        sourceType: "thread_item",
        sourceId: "item_create_001",
        contentHash,
        scopeType: "workspace",
        scopeRef: "ws_001",
      });

      const result = await createMemoryCandidateWithEntry({
        tenantId,
        invocationId: "inv_create_001",
        sourceItemId: "item_create_001",
        proposedScopeType: "workspace",
        proposedScopeRef: "ws_001",
        memoryType: "preference",
        contentRef: null,
        contentRedacted: content,
        contentHash,
        candidateKey,
        sensitivityClass: "internal",
        sourceHash: contentHash,
        rationaleCode: "USER_EXPLICIT",
      });

      // candidate：accepted + 关联 entry
      expect(result.candidate.candidateState).toBe("accepted");
      expect(result.candidate.resolvedMemoryEntryId).toBe(result.entry.id);
      expect(result.candidate.tenantId).toBe(tenantId);

      // entry：active
      expect(result.entry.memoryState).toBe("active");
      expect(result.entry.scopeType).toBe("workspace");
      expect(result.entry.scopeRef).toBe("ws_001");
      expect(result.entry.contentRedacted).toBe(content);

      // source：关联 entry + candidate
      expect(result.source.memoryEntryId).toBe(result.entry.id);
      expect(result.source.memoryCandidateId).toBe(result.candidate.id);
      expect(result.source.sourceType).toBe("thread_item");
      expect(result.source.sourceId).toBe("item_create_001");
      expect(result.source.sourceHash).toBe(contentHash);
    } finally {
      await cleanupTenantMemory(tenantId);
    }
  });

  it("insertMemoryCandidate：rejected 状态强制销毁 contentRedacted / contentRef", async () => {
    const { tenantId } = await seedContext();
    try {
      const contentHash = `sha256:${"b".repeat(64)}`;
      const candidateKey = computeCandidateKey({
        invocationId: "inv_reject_001",
        sourceType: "thread_item",
        sourceId: "item_reject_001",
        contentHash,
        scopeType: "workspace",
        scopeRef: "ws_001",
      });

      const candidate = await insertMemoryCandidate({
        tenantId,
        invocationId: "inv_reject_001",
        sourceItemId: "item_reject_001",
        proposedScopeType: "workspace",
        proposedScopeRef: "ws_001",
        memoryType: "preference",
        contentRef: "s3://bucket/secret.json",
        contentRedacted: "Bearer token_should_be_destroyed",
        contentHash,
        candidateKey,
        sensitivityClass: "confidential",
        candidateState: "rejected",
        decisionReasonCodesJson: ["sensitive_content_detected"],
        sourceHash: contentHash,
        rationaleCode: "USER_EXPLICIT",
      });

      // rejected：正文与 ref 都被销毁
      expect(candidate.candidateState).toBe("rejected");
      expect(candidate.contentRedacted).toBeNull();
      expect(candidate.contentRef).toBeNull();
      expect(candidate.resolvedMemoryEntryId).toBeNull();
      expect(candidate.decisionReasonCodesJson).toContain("sensitive_content_detected");
      expect(candidate.resolvedAt).not.toBeNull();
    } finally {
      await cleanupTenantMemory(tenantId);
    }
  });

  it("insertMemoryCandidate：needs_review 状态保留正文（待复核）", async () => {
    const { tenantId } = await seedContext();
    try {
      const content = "组织级偏好（待复核）";
      const contentHash = computeMemoryContentHash(content);
      const candidateKey = computeCandidateKey({
        invocationId: "inv_review_001",
        sourceType: "thread_item",
        sourceId: "item_review_001",
        contentHash,
        scopeType: "organization",
      });

      const candidate = await insertMemoryCandidate({
        tenantId,
        invocationId: "inv_review_001",
        sourceItemId: "item_review_001",
        proposedScopeType: "organization",
        proposedScopeRef: null,
        memoryType: "preference",
        contentRef: null,
        contentRedacted: content,
        contentHash,
        candidateKey,
        sensitivityClass: "public",
        candidateState: "needs_review",
        decisionReasonCodesJson: ["organization_scope_requires_review"],
        sourceHash: contentHash,
        rationaleCode: "USER_EXPLICIT",
      });

      expect(candidate.candidateState).toBe("needs_review");
      expect(candidate.contentRedacted).toBe(content);
      expect(candidate.resolvedMemoryEntryId).toBeNull();
      expect(candidate.resolvedAt).not.toBeNull();
    } finally {
      await cleanupTenantMemory(tenantId);
    }
  });

  it("getMemoryCandidateById：跨租户隔离", async () => {
    const { tenantId } = await seedContext();
    const otherTenantId = randomUUID();
    try {
      const contentHash = `sha256:${"c".repeat(64)}`;
      const candidateKey = computeCandidateKey({
        invocationId: "inv_cross_001",
        sourceType: "thread_item",
        sourceId: "item_cross_001",
        contentHash,
        scopeType: "workspace",
        scopeRef: "ws_001",
      });

      const created = await insertMemoryCandidate({
        tenantId,
        invocationId: "inv_cross_001",
        sourceItemId: "item_cross_001",
        proposedScopeType: "workspace",
        proposedScopeRef: "ws_001",
        memoryType: "preference",
        contentRef: null,
        contentRedacted: "正文",
        contentHash,
        candidateKey,
        sensitivityClass: "internal",
        candidateState: "needs_review",
        sourceHash: contentHash,
        rationaleCode: "USER_EXPLICIT",
      });

      // 本租户可查
      const own = await getMemoryCandidateById(tenantId, created.id);
      expect(own?.id).toBe(created.id);

      // 跨租户不可见
      const other = await getMemoryCandidateById(otherTenantId, created.id);
      expect(other).toBeNull();
    } finally {
      await cleanupTenantMemory(tenantId);
    }
  });
});

describe("memory-queries：resolveMemoryCandidate（DB 事务）", () => {
  it("accept：needs_review → accepted + 创建 entry + source + 销毁候选状态更新", async () => {
    const { tenantId } = await seedContext();
    try {
      const content = "组织级偏好（待 accept）";
      const contentHash = computeMemoryContentHash(content);
      const candidateKey = computeCandidateKey({
        invocationId: "inv_resolve_accept",
        sourceType: "thread_item",
        sourceId: "item_resolve_accept",
        contentHash,
        scopeType: "organization",
      });

      const candidate = await insertMemoryCandidate({
        tenantId,
        invocationId: "inv_resolve_accept",
        sourceItemId: "item_resolve_accept",
        proposedScopeType: "organization",
        proposedScopeRef: null,
        memoryType: "preference",
        contentRef: null,
        contentRedacted: content,
        contentHash,
        candidateKey,
        sensitivityClass: "public",
        candidateState: "needs_review",
        decisionReasonCodesJson: ["organization_scope_requires_review"],
        sourceHash: contentHash,
        rationaleCode: "USER_EXPLICIT",
      });

      // accept + scope 收窄到 workspace
      const result = await resolveMemoryCandidate({
        tenantId,
        candidateId: candidate.id,
        decision: "accept",
        resolvedScopeType: "workspace",
        resolvedScopeRef: "ws_001",
        reasonCodes: ["admin_approved"],
      });

      expect(result.candidate.candidateState).toBe("accepted");
      expect(result.candidate.resolvedMemoryEntryId).toBe(result.entry?.id);
      expect(result.entry?.scopeType).toBe("workspace");
      expect(result.entry?.scopeRef).toBe("ws_001");
      expect(result.entry?.memoryState).toBe("active");
      expect(result.entry?.contentRedacted).toBe(content);
      expect(result.source?.memoryCandidateId).toBe(candidate.id);
      expect(result.candidate.decisionReasonCodesJson).toContain("admin_approved");

      // 校验 entry 可查
      const entry = await getMemoryEntryById(tenantId, result.entry?.id ?? "");
      expect(entry?.id).toBe(result.entry?.id);
    } finally {
      await cleanupTenantMemory(tenantId);
    }
  });

  it("reject：needs_review → rejected + 销毁正文 + 不创建 entry", async () => {
    const { tenantId } = await seedContext();
    try {
      const content = "组织级偏好（待 reject）";
      const contentHash = computeMemoryContentHash(content);
      const candidateKey = computeCandidateKey({
        invocationId: "inv_resolve_reject",
        sourceType: "thread_item",
        sourceId: "item_resolve_reject",
        contentHash,
        scopeType: "organization",
      });

      const candidate = await insertMemoryCandidate({
        tenantId,
        invocationId: "inv_resolve_reject",
        sourceItemId: "item_resolve_reject",
        proposedScopeType: "organization",
        proposedScopeRef: null,
        memoryType: "preference",
        contentRef: null,
        contentRedacted: content,
        contentHash,
        candidateKey,
        sensitivityClass: "public",
        candidateState: "needs_review",
        sourceHash: contentHash,
        rationaleCode: "USER_EXPLICIT",
      });

      const result = await resolveMemoryCandidate({
        tenantId,
        candidateId: candidate.id,
        decision: "reject",
        reasonCodes: ["admin_rejected"],
      });

      expect(result.candidate.candidateState).toBe("rejected");
      expect(result.candidate.contentRedacted).toBeNull();
      expect(result.candidate.contentRef).toBeNull();
      expect(result.candidate.resolvedMemoryEntryId).toBeNull();
      expect(result.entry).toBeUndefined();
      expect(result.source).toBeUndefined();
    } finally {
      await cleanupTenantMemory(tenantId);
    }
  });

  it("已复核 candidate 再次 resolve → 抛 MemoryCandidateAlreadyResolvedError", async () => {
    const { tenantId } = await seedContext();
    try {
      const contentHash = `sha256:${"d".repeat(64)}`;
      const candidateKey = computeCandidateKey({
        invocationId: "inv_resolve_dup",
        sourceType: "thread_item",
        sourceId: "item_resolve_dup",
        contentHash,
        scopeType: "organization",
      });

      // 直接创建 rejected candidate（跳过 needs_review；rejected 状态满足
      // V11MemoryCandidate_rejected_entry_ck：resolvedMemoryEntryId 必须为 null）
      const candidate = await insertMemoryCandidate({
        tenantId,
        invocationId: "inv_resolve_dup",
        sourceItemId: "item_resolve_dup",
        proposedScopeType: "organization",
        proposedScopeRef: null,
        memoryType: "preference",
        contentRef: null,
        contentRedacted: "正文",
        contentHash,
        candidateKey,
        sensitivityClass: "public",
        candidateState: "rejected",
        resolvedMemoryEntryId: null,
        sourceHash: contentHash,
        rationaleCode: "USER_EXPLICIT",
      });

      await expect(
        resolveMemoryCandidate({
          tenantId,
          candidateId: candidate.id,
          decision: "accept",
        }),
      ).rejects.toThrow(MemoryCandidateAlreadyResolvedError);
    } finally {
      await cleanupTenantMemory(tenantId);
    }
  });

  it("不存在 candidate → 抛普通 Error（非已复核错误）", async () => {
    const { tenantId } = await seedContext();
    await expect(
      resolveMemoryCandidate({
        tenantId,
        candidateId: "nonexistent-id",
        decision: "accept",
      }),
    ).rejects.not.toThrow(MemoryCandidateAlreadyResolvedError);
  });
});

// ═══════════════════════════════════════════════════════════
// 2. POST /gateway/v1/memory-candidates
// ═══════════════════════════════════════════════════════════

describe("POST /gateway/v1/memory-candidates", () => {
  it("缺少 Token → 401 AUTHENTICATION_REQUIRED", async () => {
    await seedContext();
    const request = buildV11Request({
      audience: "gateway",
      method: "POST",
      path: "/memory-candidates",
      idempotencyKey: "idem-mem-1",
      body: makeBody(),
    });
    const response = await memoryCandidatePOST(request);
    expect(response.status).toBe(401);
    const body = await response.json();
    expect(body.error.code).toBe("AUTHENTICATION_REQUIRED");
  });

  it("缺少 Idempotency-Key → 400 REQUEST_SCHEMA_INVALID", async () => {
    const { tenantId } = await seedContext();
    const token = makeGatewayToken(tenantId, "inv_mem_001");
    const request = buildV11Request({
      audience: "gateway",
      method: "POST",
      path: "/memory-candidates",
      token,
      body: makeBody(),
    });
    const response = await memoryCandidatePOST(request);
    expect(response.status).toBe(400);
    const body = await response.json();
    expect(body.error.code).toBe("REQUEST_SCHEMA_INVALID");
  });

  it("请求体 invocation_id 与 Token invocationId 不一致 → 400", async () => {
    const { tenantId } = await seedContext();
    const token = makeGatewayToken(tenantId, "inv_from_token");
    const request = buildV11Request({
      audience: "gateway",
      method: "POST",
      path: "/memory-candidates",
      token,
      idempotencyKey: "idem-mem-2",
      body: makeBody({ invocation_id: "inv_from_body" }),
    });
    const response = await memoryCandidatePOST(request);
    expect(response.status).toBe(400);
    const body = await response.json();
    expect(body.error.code).toBe("REQUEST_SCHEMA_INVALID");
  });

  it("source.item_id / job_id / artifact_id 全空 → 400", async () => {
    const { tenantId } = await seedContext();
    const token = makeGatewayToken(tenantId, "inv_mem_001");
    const request = buildV11Request({
      audience: "gateway",
      method: "POST",
      path: "/memory-candidates",
      token,
      idempotencyKey: "idem-mem-3",
      body: makeBody({ source: { thread_id: "t1", turn_id: "t1" } }),
    });
    const response = await memoryCandidatePOST(request);
    expect(response.status).toBe(400);
  });

  it("source.item_id / job_id / artifact_id 多个非空 → 400", async () => {
    const { tenantId } = await seedContext();
    const token = makeGatewayToken(tenantId, "inv_mem_001");
    const request = buildV11Request({
      audience: "gateway",
      method: "POST",
      path: "/memory-candidates",
      token,
      idempotencyKey: "idem-mem-4",
      body: makeBody({ source: { item_id: "i1", job_id: "j1" } }),
    });
    const response = await memoryCandidatePOST(request);
    expect(response.status).toBe(400);
  });

  it("非法 proposed_scope.type → 400", async () => {
    const { tenantId } = await seedContext();
    const token = makeGatewayToken(tenantId, "inv_mem_001");
    const request = buildV11Request({
      audience: "gateway",
      method: "POST",
      path: "/memory-candidates",
      token,
      idempotencyKey: "idem-mem-5",
      body: makeBody({ proposed_scope: { type: "invalid_scope" } }),
    });
    const response = await memoryCandidatePOST(request);
    expect(response.status).toBe(400);
  });

  it("非法 content_hash 格式 → 400", async () => {
    const { tenantId } = await seedContext();
    const token = makeGatewayToken(tenantId, "inv_mem_001");
    const request = buildV11Request({
      audience: "gateway",
      method: "POST",
      path: "/memory-candidates",
      token,
      idempotencyKey: "idem-mem-6",
      body: makeBody({ content_hash: "not-a-hash" }),
    });
    const response = await memoryCandidatePOST(request);
    expect(response.status).toBe(400);
  });

  it("content_hash 与 content.text 不一致 → 409 MEMORY_CONTENT_HASH_MISMATCH", async () => {
    const { tenantId } = await seedContext();
    const token = makeGatewayToken(tenantId, "inv_mem_001");
    const request = buildV11Request({
      audience: "gateway",
      method: "POST",
      path: "/memory-candidates",
      token,
      idempotencyKey: "idem-mem-7",
      body: makeBody({
        content_hash: `sha256:${"0".repeat(64)}`,
      }),
    });
    const response = await memoryCandidatePOST(request);
    expect(response.status).toBe(409);
    const body = await response.json();
    expect(body.error.code).toBe("MEMORY_CONTENT_HASH_MISMATCH");
  });

  it("accepted 路径 → 201 + memory_entry_id 非空", async () => {
    const { tenantId } = await seedContext();
    const token = makeGatewayToken(tenantId, "inv_mem_accept_001");
    const body = makeBody({ invocation_id: "inv_mem_accept_001" });
    const request = buildV11Request({
      audience: "gateway",
      method: "POST",
      path: "/memory-candidates",
      token,
      idempotencyKey: "idem-mem-accept-1",
      body,
    });
    const response = await memoryCandidatePOST(request);
    expect(response.status).toBe(201);
    const respBody = await response.json();
    expect(respBody.candidate_id).toBeDefined();
    expect(respBody.candidate_state).toBe("accepted");
    expect(respBody.memory_entry_id).not.toBeNull();
    expect(respBody.proposed_scope.type).toBe("workspace");
    expect(respBody.proposed_scope.ref).toBe("ws_001");
    expect(respBody.proposed_at).toMatch(/^\d{4}-\d{2}-\d{2}T.*Z$/);
    expect(respBody.resolved_at).not.toBeNull();

    await cleanupTenantMemory(tenantId);
  });

  it("rejected 路径（敏感内容）→ 201 + candidate_state=rejected + memory_entry_id=null", async () => {
    const { tenantId } = await seedContext();
    const token = makeGatewayToken(tenantId, "inv_mem_reject_001");
    const sensitiveText = "Authorization: Bearer abcdef1234567890abcdef";
    const body = makeBody({
      invocation_id: "inv_mem_reject_001",
      content: { text: sensitiveText },
      content_hash: computeMemoryContentHash(sensitiveText),
    });
    const request = buildV11Request({
      audience: "gateway",
      method: "POST",
      path: "/memory-candidates",
      token,
      idempotencyKey: "idem-mem-reject-1",
      body,
    });
    const response = await memoryCandidatePOST(request);
    expect(response.status).toBe(201);
    const respBody = await response.json();
    expect(respBody.candidate_state).toBe("rejected");
    expect(respBody.memory_entry_id).toBeNull();
    expect(respBody.decision_reason_codes).toContain("sensitive_content_detected");

    // 验证 DB 中正文已销毁
    const candidate = await getMemoryCandidateById(tenantId, respBody.candidate_id);
    expect(candidate?.contentRedacted).toBeNull();
    expect(candidate?.contentRef).toBeNull();

    await cleanupTenantMemory(tenantId);
  });

  it("needs_review 路径（organization scope）→ 201 + candidate_state=needs_review", async () => {
    const { tenantId } = await seedContext();
    const token = makeGatewayToken(tenantId, "inv_mem_review_001");
    const body = makeBody({
      invocation_id: "inv_mem_review_001",
      proposed_scope: { type: "organization" },
    });
    const request = buildV11Request({
      audience: "gateway",
      method: "POST",
      path: "/memory-candidates",
      token,
      idempotencyKey: "idem-mem-review-1",
      body,
    });
    const response = await memoryCandidatePOST(request);
    expect(response.status).toBe(201);
    const respBody = await response.json();
    expect(respBody.candidate_state).toBe("needs_review");
    expect(respBody.memory_entry_id).toBeNull();
    expect(respBody.decision_reason_codes).toContain("organization_scope_requires_review");

    await cleanupTenantMemory(tenantId);
  });

  it("幂等重放：同 Idempotency-Key 同 body → 返回原 201 响应", async () => {
    const { tenantId } = await seedContext();
    const token = makeGatewayToken(tenantId, "inv_mem_idempotent_001");
    const body = makeBody({ invocation_id: "inv_mem_idempotent_001" });

    const request1 = buildV11Request({
      audience: "gateway",
      method: "POST",
      path: "/memory-candidates",
      token,
      idempotencyKey: "idem-mem-replay-1",
      body,
    });
    const response1 = await memoryCandidatePOST(request1);
    expect(response1.status).toBe(201);
    const respBody1 = await response1.json();

    const request2 = buildV11Request({
      audience: "gateway",
      method: "POST",
      path: "/memory-candidates",
      token,
      idempotencyKey: "idem-mem-replay-1",
      body,
    });
    const response2 = await memoryCandidatePOST(request2);
    expect(response2.status).toBe(201);
    const respBody2 = await response2.json();
    expect(respBody2.candidate_id).toBe(respBody1.candidate_id);

    await cleanupTenantMemory(tenantId);
  });

  it("幂等冲突：同 Idempotency-Key 不同 body → 409 IDEMPOTENCY_CONFLICT", async () => {
    const { tenantId } = await seedContext();
    const token = makeGatewayToken(tenantId, "inv_mem_conflict_001");

    const body1 = makeBody({
      invocation_id: "inv_mem_conflict_001",
      proposed_scope: { type: "workspace", ref: "ws_A" },
    });
    const request1 = buildV11Request({
      audience: "gateway",
      method: "POST",
      path: "/memory-candidates",
      token,
      idempotencyKey: "idem-mem-conflict-1",
      body: body1,
    });
    const response1 = await memoryCandidatePOST(request1);
    expect(response1.status).toBe(201);

    // 同 key 不同 body（scope.ref 不同 → content_hash 不变但 candidate_key 变）
    const body2 = makeBody({
      invocation_id: "inv_mem_conflict_001",
      proposed_scope: { type: "workspace", ref: "ws_B" },
    });
    const request2 = buildV11Request({
      audience: "gateway",
      method: "POST",
      path: "/memory-candidates",
      token,
      idempotencyKey: "idem-mem-conflict-1",
      body: body2,
    });
    const response2 = await memoryCandidatePOST(request2);
    expect(response2.status).toBe(409);
    const respBody2 = await response2.json();
    expect(respBody2.error.code).toBe("IDEMPOTENCY_CONFLICT");

    await cleanupTenantMemory(tenantId);
  });

  it("candidate_key 去重：不同 Idempotency-Key 相同 body → 返回已有 candidate", async () => {
    const { tenantId } = await seedContext();
    const token = makeGatewayToken(tenantId, "inv_mem_dedup_001");
    const body = makeBody({ invocation_id: "inv_mem_dedup_001" });

    // 第一次创建
    const request1 = buildV11Request({
      audience: "gateway",
      method: "POST",
      path: "/memory-candidates",
      token,
      idempotencyKey: "idem-mem-dedup-1",
      body,
    });
    const response1 = await memoryCandidatePOST(request1);
    expect(response1.status).toBe(201);
    const respBody1 = await response1.json();

    // 第二次用不同 Idempotency-Key 但相同 body → 应去重返回已有 candidate
    const request2 = buildV11Request({
      audience: "gateway",
      method: "POST",
      path: "/memory-candidates",
      token,
      idempotencyKey: "idem-mem-dedup-2",
      body,
    });
    const response2 = await memoryCandidatePOST(request2);
    expect(response2.status).toBe(201);
    const respBody2 = await response2.json();
    expect(respBody2.candidate_id).toBe(respBody1.candidate_id);

    // 验证 DB 只有一行 candidate
    const rows = await db
      .select()
      .from(memoryCandidate)
      .where(eq(memoryCandidate.invocationId, "inv_mem_dedup_001"));
    expect(rows).toHaveLength(1);

    await cleanupTenantMemory(tenantId);
  });

  it("跨租户隔离：不同租户 Token 创建各自 Candidate", async () => {
    const { tenantId: tenant1 } = await seedContext();
    // 创建第二个租户
    const tenant2 = randomUUID();
    await db.insert(tenantTable).values({
      id: tenant2,
      key: `t-${tenant2.slice(0, 8)}`,
      name: "第二租户",
      status: "active",
    });

    // candidate_key = sha256(invocation_id|...) 全局唯一（invocation_id 跨租户唯一），
    // 因此两租户必须用不同 invocation_id，否则 candidateKey 唯一约束冲突。
    const token1 = makeGatewayToken(tenant1, "inv_mem_cross_001");
    const token2 = makeGatewayToken(tenant2, "inv_mem_cross_002");

    const body1 = makeBody({ invocation_id: "inv_mem_cross_001" });
    const body2 = makeBody({ invocation_id: "inv_mem_cross_002" });
    const request1 = buildV11Request({
      audience: "gateway",
      method: "POST",
      path: "/memory-candidates",
      token: token1,
      idempotencyKey: "idem-mem-cross-1",
      body: body1,
    });
    const response1 = await memoryCandidatePOST(request1);
    expect(response1.status).toBe(201);
    const respBody1 = await response1.json();

    const request2 = buildV11Request({
      audience: "gateway",
      method: "POST",
      path: "/memory-candidates",
      token: token2,
      idempotencyKey: "idem-mem-cross-2",
      body: body2,
    });
    const response2 = await memoryCandidatePOST(request2);
    expect(response2.status).toBe(201);
    const respBody2 = await response2.json();

    // 不同租户产生不同 candidate
    expect(respBody2.candidate_id).not.toBe(respBody1.candidate_id);

    await cleanupTenantMemory(tenant1);
    await cleanupTenantMemory(tenant2);
  });
});

// ═══════════════════════════════════════════════════════════
// 3. GET /gateway/v1/memory-candidates/{id}
// ═══════════════════════════════════════════════════════════

describe("GET /gateway/v1/memory-candidates/{id}", () => {
  it("跨 invocation 隔离 → 404 RESOURCE_NOT_FOUND（隐藏式）", async () => {
    const { tenantId } = await seedContext();
    // 创建 candidate（绑定 invocation A）
    const token1 = makeGatewayToken(tenantId, "inv_get_A");
    const createBody = makeBody({ invocation_id: "inv_get_A" });
    const createReq = buildV11Request({
      audience: "gateway",
      method: "POST",
      path: "/memory-candidates",
      token: token1,
      idempotencyKey: "idem-get-create-1",
      body: createBody,
    });
    const createResp = await memoryCandidatePOST(createReq);
    expect(createResp.status).toBe(201);
    const created = await createResp.json();

    try {
      // 用不同 invocation Token 查询 → 隐藏式 404
      const token2 = makeGatewayToken(tenantId, "inv_get_B");
      const getReq = buildV11Request({
        audience: "gateway",
        method: "GET",
        path: `/memory-candidates/${created.candidate_id}`,
        token: token2,
      });
      const getResp = await memoryCandidateGET(getReq);
      expect(getResp.status).toBe(404);
      const body = await getResp.json();
      expect(body.error.code).toBe("RESOURCE_NOT_FOUND");
    } finally {
      await cleanupTenantMemory(tenantId);
    }
  });

  it("成功查询 → 200 + 完整投影", async () => {
    const { tenantId } = await seedContext();
    const invocationId = "inv_get_success";
    const token = makeGatewayToken(tenantId, invocationId);
    const createBody = makeBody({ invocation_id: invocationId });
    const createReq = buildV11Request({
      audience: "gateway",
      method: "POST",
      path: "/memory-candidates",
      token,
      idempotencyKey: "idem-get-success-1",
      body: createBody,
    });
    const createResp = await memoryCandidatePOST(createReq);
    expect(createResp.status).toBe(201);
    const created = await createResp.json();

    try {
      const getReq = buildV11Request({
        audience: "gateway",
        method: "GET",
        path: `/memory-candidates/${created.candidate_id}`,
        token,
      });
      const getResp = await memoryCandidateGET(getReq);
      expect(getResp.status).toBe(200);
      const body = await getResp.json();
      expect(body.candidate_id).toBe(created.candidate_id);
      expect(body.invocation_id).toBe(invocationId);
      expect(body.candidate_state).toBe("accepted");
      expect(body.memory_entry_id).toBe(created.memory_entry_id);
      expect(body.proposed_scope.type).toBe("workspace");
      expect(body.proposed_scope.ref).toBe("ws_001");
      expect(body.memory_type).toBe("preference");
      expect(body.content_hash).toMatch(/^sha256:[0-9a-f]{64}$/);
      expect(body.sensitivity_class).toBe("internal");
    } finally {
      await cleanupTenantMemory(tenantId);
    }
  });

  it("缺少 Token → 401 AUTHENTICATION_REQUIRED", async () => {
    await seedContext();
    const request = buildV11Request({
      audience: "gateway",
      method: "GET",
      path: "/memory-candidates/some-id",
    });
    const response = await memoryCandidateGET(request);
    expect(response.status).toBe(401);
    const body = await response.json();
    expect(body.error.code).toBe("AUTHENTICATION_REQUIRED");
  });
});

// ═══════════════════════════════════════════════════════════
// 4. POST /admin/api/v1/memory-candidates/{id}:resolve
// ═══════════════════════════════════════════════════════════

describe("POST /admin/api/v1/memory-candidates/{id}:resolve", () => {
  /** 准备一个 needs_review candidate（organization scope），返回 candidateId。 */
  async function seedNeedsReviewCandidate(
    tenantId: string,
    invocationId = "inv_resolve_admin_001",
  ): Promise<string> {
    const token = makeGatewayToken(tenantId, invocationId);
    const createBody = makeBody({
      invocation_id: invocationId,
      proposed_scope: { type: "organization" },
    });
    const createReq = buildV11Request({
      audience: "gateway",
      method: "POST",
      path: "/memory-candidates",
      token,
      idempotencyKey: `idem-seed-${invocationId}`,
      body: createBody,
    });
    const createResp = await memoryCandidatePOST(createReq);
    expect(createResp.status).toBe(201);
    const created = await createResp.json();
    expect(created.candidate_state).toBe("needs_review");
    return created.candidate_id as string;
  }

  it("缺少身份 → 401 AUTHENTICATION_REQUIRED", async () => {
    const { tenantId } = await seedContext();
    const candidateId = await seedNeedsReviewCandidate(tenantId);
    try {
      // dev 模式下无 header 会回落到默认用户（不抛错），
      // 因此用无效 Bearer Token 触发 WorkloadTokenError → 401。
      const request = buildV11Request({
        audience: "admin",
        method: "POST",
        path: `/memory-candidates/${candidateId}:resolve`,
        token: "invalid-workload-token",
        idempotencyKey: "idem-resolve-noauth-1",
        body: { decision: "accept" },
      });
      const response = await memoryCandidateResolvePOST(request);
      expect(response.status).toBe(401);
      const body = await response.json();
      expect(body.error.code).toBe("AUTHENTICATION_REQUIRED");
    } finally {
      await cleanupTenantMemory(tenantId);
    }
  });

  it("缺少 Idempotency-Key → 400 REQUEST_SCHEMA_INVALID", async () => {
    const { tenantId } = await seedContext();
    const candidateId = await seedNeedsReviewCandidate(tenantId);
    try {
      const request = buildV11Request({
        audience: "admin",
        method: "POST",
        path: `/memory-candidates/${candidateId}:resolve`,
        body: { decision: "accept" },
      });
      const response = await memoryCandidateResolvePOST(request);
      expect(response.status).toBe(400);
    } finally {
      await cleanupTenantMemory(tenantId);
    }
  });

  it("缺少 action scope 绑定 → 403 ACTION_SCOPE_DENIED", async () => {
    const { tenantId } = await seedContext();
    const candidateId = await seedNeedsReviewCandidate(tenantId);
    try {
      const request = buildV11Request({
        audience: "admin",
        method: "POST",
        path: `/memory-candidates/${candidateId}:resolve`,
        idempotencyKey: "idem-resolve-noscope-1",
        body: { decision: "accept" },
      });
      const response = await memoryCandidateResolvePOST(request);
      expect(response.status).toBe(403);
      const body = await response.json();
      expect(body.error.code).toBe("ACTION_SCOPE_DENIED");
    } finally {
      await cleanupTenantMemory(tenantId);
    }
  });

  it("accept → 200 + memory_entry_id 非空 + candidate_state=accepted", async () => {
    const { tenantId, principalBindingId } = await seedContext();
    // 授予 memory.review + workspace wildcard scope（覆盖收窄后的 workspace）
    await grantActionBinding({
      tenantId,
      principalBindingId,
      actionCode: "memory.review",
      resourceScope: { type: "workspace", wildcard: true },
    });
    // 还需 organization scope 才能 review organization candidate
    await grantActionBinding({
      tenantId,
      principalBindingId,
      actionCode: "memory.review",
      resourceScope: { type: "organization", wildcard: true },
    });

    const candidateId = await seedNeedsReviewCandidate(tenantId);
    try {
      const request = buildV11Request({
        audience: "admin",
        method: "POST",
        path: `/memory-candidates/${candidateId}:resolve`,
        idempotencyKey: "idem-resolve-accept-1",
        body: {
          decision: "accept",
          scope: { type: "workspace", ref: "ws_resolved" },
          reason_codes: ["admin_approved"],
        },
      });
      const response = await memoryCandidateResolvePOST(request);
      expect(response.status).toBe(200);
      const body = await response.json();
      expect(body.candidate_state).toBe("accepted");
      expect(body.memory_entry_id).not.toBeNull();
      expect(body.decision_reason_codes).toContain("admin_approved");

      // 验证 entry 的 scope 已收窄
      const candidate = await getMemoryCandidateById(tenantId, candidateId);
      const entry = await getMemoryEntryById(tenantId, candidate?.resolvedMemoryEntryId ?? "");
      expect(entry?.scopeType).toBe("workspace");
      expect(entry?.scopeRef).toBe("ws_resolved");
    } finally {
      await cleanupTenantMemory(tenantId);
    }
  });

  it("reject → 200 + candidate_state=rejected + 正文已销毁", async () => {
    const { tenantId, principalBindingId } = await seedContext();
    await grantActionBinding({
      tenantId,
      principalBindingId,
      actionCode: "memory.review",
      resourceScope: { type: "organization", wildcard: true },
    });

    const candidateId = await seedNeedsReviewCandidate(tenantId);
    try {
      const request = buildV11Request({
        audience: "admin",
        method: "POST",
        path: `/memory-candidates/${candidateId}:resolve`,
        idempotencyKey: "idem-resolve-reject-1",
        body: {
          decision: "reject",
          reason_codes: ["admin_rejected"],
        },
      });
      const response = await memoryCandidateResolvePOST(request);
      expect(response.status).toBe(200);
      const body = await response.json();
      expect(body.candidate_state).toBe("rejected");
      expect(body.memory_entry_id).toBeNull();

      // 验证 DB 中正文已销毁
      const candidate = await getMemoryCandidateById(tenantId, candidateId);
      expect(candidate?.contentRedacted).toBeNull();
      expect(candidate?.contentRef).toBeNull();
    } finally {
      await cleanupTenantMemory(tenantId);
    }
  });

  it("scope 收窄方向非法（workspace → organization 扩大）→ 400 REQUEST_SCHEMA_INVALID", async () => {
    const { tenantId, principalBindingId } = await seedContext();
    // candidate.proposedScopeType=workspace，requireAdminActionScope 用 resource={type:"workspace"}
    // 校验，因此必须授予 workspace scope 让 action scope 校验通过，才能到达 scope 收窄校验。
    await grantActionBinding({
      tenantId,
      principalBindingId,
      actionCode: "memory.review",
      resourceScope: { type: "workspace", wildcard: true },
    });

    // seed 一个 workspace scope 的 needs_review candidate（通过直接插入，绕过 Policy 自动 accept）
    const content = "工作空间偏好（手动 needs_review）";
    const contentHash = computeMemoryContentHash(content);
    const candidateKey = computeCandidateKey({
      invocationId: "inv_resolve_narrow",
      sourceType: "thread_item",
      sourceId: "item_resolve_narrow",
      contentHash,
      scopeType: "workspace",
      scopeRef: "ws_001",
    });
    const candidate = await insertMemoryCandidate({
      tenantId,
      invocationId: "inv_resolve_narrow",
      sourceItemId: "item_resolve_narrow",
      proposedScopeType: "workspace",
      proposedScopeRef: "ws_001",
      memoryType: "preference",
      contentRef: null,
      contentRedacted: content,
      contentHash,
      candidateKey,
      sensitivityClass: "internal",
      candidateState: "needs_review",
      sourceHash: contentHash,
      rationaleCode: "USER_EXPLICIT",
    });

    try {
      const request = buildV11Request({
        audience: "admin",
        method: "POST",
        path: `/memory-candidates/${candidate.id}:resolve`,
        idempotencyKey: "idem-resolve-narrow-1",
        body: {
          decision: "accept",
          // 试图扩大 scope：workspace → organization（非法）
          scope: { type: "organization" },
        },
      });
      const response = await memoryCandidateResolvePOST(request);
      expect(response.status).toBe(400);
      const body = await response.json();
      expect(body.error.code).toBe("REQUEST_SCHEMA_INVALID");
    } finally {
      await cleanupTenantMemory(tenantId);
    }
  });

  it("已复核 candidate → 409 MEMORY_CANDIDATE_ALREADY_RESOLVED", async () => {
    const { tenantId, principalBindingId } = await seedContext();
    await grantActionBinding({
      tenantId,
      principalBindingId,
      actionCode: "memory.review",
      resourceScope: { type: "organization", wildcard: true },
    });

    const candidateId = await seedNeedsReviewCandidate(tenantId);
    try {
      // 第一次 resolve（accept）
      const request1 = buildV11Request({
        audience: "admin",
        method: "POST",
        path: `/memory-candidates/${candidateId}:resolve`,
        idempotencyKey: "idem-resolve-already-1",
        body: { decision: "accept" },
      });
      const response1 = await memoryCandidateResolvePOST(request1);
      expect(response1.status).toBe(200);

      // 第二次 resolve（用不同 Idempotency-Key）→ 409 MEMORY_CANDIDATE_ALREADY_RESOLVED
      const request2 = buildV11Request({
        audience: "admin",
        method: "POST",
        path: `/memory-candidates/${candidateId}:resolve`,
        idempotencyKey: "idem-resolve-already-2",
        body: { decision: "reject" },
      });
      const response2 = await memoryCandidateResolvePOST(request2);
      expect(response2.status).toBe(409);
      const body2 = await response2.json();
      expect(body2.error.code).toBe("MEMORY_CANDIDATE_ALREADY_RESOLVED");
    } finally {
      await cleanupTenantMemory(tenantId);
    }
  });

  it("幂等重放：同 Idempotency-Key 同 body → 返回原 200 响应", async () => {
    const { tenantId, principalBindingId } = await seedContext();
    await grantActionBinding({
      tenantId,
      principalBindingId,
      actionCode: "memory.review",
      resourceScope: { type: "organization", wildcard: true },
    });

    const candidateId = await seedNeedsReviewCandidate(tenantId);
    try {
      const body = { decision: "accept" };
      const request1 = buildV11Request({
        audience: "admin",
        method: "POST",
        path: `/memory-candidates/${candidateId}:resolve`,
        idempotencyKey: "idem-resolve-replay-1",
        body,
      });
      const response1 = await memoryCandidateResolvePOST(request1);
      expect(response1.status).toBe(200);
      const respBody1 = await response1.json();

      const request2 = buildV11Request({
        audience: "admin",
        method: "POST",
        path: `/memory-candidates/${candidateId}:resolve`,
        idempotencyKey: "idem-resolve-replay-1",
        body,
      });
      const response2 = await memoryCandidateResolvePOST(request2);
      expect(response2.status).toBe(200);
      const respBody2 = await response2.json();
      expect(respBody2.candidate_id).toBe(respBody1.candidate_id);
    } finally {
      await cleanupTenantMemory(tenantId);
    }
  });

  it("Candidate 不存在 → 404 RESOURCE_NOT_FOUND", async () => {
    const { tenantId, principalBindingId } = await seedContext();
    await grantActionBinding({
      tenantId,
      principalBindingId,
      actionCode: "memory.review",
      resourceScope: { type: "organization", wildcard: true },
    });

    const randomId = randomUUID();
    const request = buildV11Request({
      audience: "admin",
      method: "POST",
      path: `/memory-candidates/${randomId}:resolve`,
      idempotencyKey: "idem-resolve-notfound-1",
      body: { decision: "accept" },
    });
    const response = await memoryCandidateResolvePOST(request);
    expect(response.status).toBe(404);
    const body = await response.json();
    expect(body.error.code).toBe("RESOURCE_NOT_FOUND");
  });

  it("thread scope candidate 不支持复核 → 403 ACTION_SCOPE_DENIED", async () => {
    const { tenantId } = await seedContext();
    // 直接插入 thread scope 的 needs_review candidate（绕过 Policy，Policy 会自动 accept thread scope）
    const content = "thread 级偏好";
    const contentHash = computeMemoryContentHash(content);
    const candidateKey = computeCandidateKey({
      invocationId: "inv_resolve_thread",
      sourceType: "thread_item",
      sourceId: "item_resolve_thread",
      contentHash,
      scopeType: "thread",
      scopeRef: "thread_001",
    });
    const candidate = await insertMemoryCandidate({
      tenantId,
      invocationId: "inv_resolve_thread",
      sourceItemId: "item_resolve_thread",
      proposedScopeType: "thread",
      proposedScopeRef: "thread_001",
      memoryType: "preference",
      contentRef: null,
      contentRedacted: content,
      contentHash,
      candidateKey,
      sensitivityClass: "internal",
      candidateState: "needs_review",
      sourceHash: contentHash,
      rationaleCode: "USER_EXPLICIT",
    });

    try {
      const request = buildV11Request({
        audience: "admin",
        method: "POST",
        path: `/memory-candidates/${candidate.id}:resolve`,
        idempotencyKey: "idem-resolve-thread-1",
        body: { decision: "accept" },
      });
      const response = await memoryCandidateResolvePOST(request);
      expect(response.status).toBe(403);
      const body = await response.json();
      expect(body.error.code).toBe("ACTION_SCOPE_DENIED");
    } finally {
      await cleanupTenantMemory(tenantId);
    }
  });
});

// ═══════════════════════════════════════════════════════════
// 5. 跨场景：withRollback 验证事务隔离
// ═══════════════════════════════════════════════════════════

describe("memory-queries：withRollback 事务隔离", () => {
  it("createMemoryCandidateWithEntry 在事务内可读回，事务回滚后不可见", async () => {
    const { tenantId } = await seedContext();
    const content = "事务内 candidate";
    const contentHash = computeMemoryContentHash(content);
    const candidateKey = computeCandidateKey({
      invocationId: "inv_rb_001",
      sourceType: "thread_item",
      sourceId: "item_rb_001",
      contentHash,
      scopeType: "workspace",
      scopeRef: "ws_001",
    });

    let createdCandidateId: string | undefined;
    await withRollback(db, async (tx) => {
      const result = await createMemoryCandidateWithEntry({
        tenantId,
        invocationId: "inv_rb_001",
        sourceItemId: "item_rb_001",
        proposedScopeType: "workspace",
        proposedScopeRef: "ws_001",
        memoryType: "preference",
        contentRef: null,
        contentRedacted: content,
        contentHash,
        candidateKey,
        sensitivityClass: "internal",
        sourceHash: contentHash,
        rationaleCode: "USER_EXPLICIT",
        tx,
      });
      createdCandidateId = result.candidate.id;
      // 注意：getMemoryCandidateById 用 db（非 tx），无法读到未提交数据，
      // 这里仅验证 candidate id 与 entry id 已生成。
      expect(result.candidate.id).toBeDefined();
      expect(result.entry.id).toBeDefined();
    });

    // 事务回滚后，db 中不应有该 candidate
    if (createdCandidateId) {
      const after = await getMemoryCandidateById(tenantId, createdCandidateId);
      expect(after).toBeNull();
    }
  });
});

// ═══════════════════════════════════════════════════════════
// S07-C04：Memory 作用域检索与用户控制
// ═══════════════════════════════════════════════════════════

describe("memory-queries S07-C04：computeMemoryEntryKey", () => {
  it("返回 sha256: 前缀 + 64 hex", () => {
    const key = computeMemoryEntryKey({
      tenantId: "t1",
      scopeType: "workspace",
      scopeRef: "ws_001",
      memoryType: "preference",
      contentHash: `sha256:${"a".repeat(64)}`,
    });
    expect(key).toMatch(/^sha256:[0-9a-f]{64}$/);
  });

  it("相同字段产生相同 key", () => {
    const params = {
      tenantId: "t1",
      scopeType: "workspace" as const,
      scopeRef: "ws_001",
      memoryType: "preference",
      contentHash: `sha256:${"a".repeat(64)}`,
    };
    expect(computeMemoryEntryKey(params)).toBe(computeMemoryEntryKey(params));
  });

  it("scope_ref null 与空字符串等价", () => {
    const base = {
      tenantId: "t1",
      scopeType: "user_preference" as const,
      memoryType: "preference",
      contentHash: `sha256:${"a".repeat(64)}`,
    };
    expect(computeMemoryEntryKey({ ...base, scopeRef: null })).toBe(
      computeMemoryEntryKey({ ...base, scopeRef: "" }),
    );
  });

  it("不同 tenantId 产生不同 key", () => {
    const base = {
      tenantId: "t1",
      scopeType: "workspace" as const,
      scopeRef: "ws_001",
      memoryType: "preference",
      contentHash: `sha256:${"a".repeat(64)}`,
    };
    expect(computeMemoryEntryKey({ ...base, tenantId: "t2" })).not.toBe(
      computeMemoryEntryKey(base),
    );
  });
});

describe("memory-queries S07-C04：listActiveMemoryEntriesByScopes（DB）", () => {
  it("按多作用域返回 active Entry（thread + workspace）", async () => {
    const { tenantId } = await seedContext();
    try {
      const content1 = "thread 级记忆";
      const hash1 = computeMemoryContentHash(content1);
      const key1 = computeCandidateKey({
        invocationId: "inv_list_001",
        sourceType: "thread_item",
        sourceId: "item_list_001",
        contentHash: hash1,
        scopeType: "thread",
        scopeRef: "thread_list_001",
      });
      await createMemoryCandidateWithEntry({
        tenantId,
        invocationId: "inv_list_001",
        sourceItemId: "item_list_001",
        proposedScopeType: "thread",
        proposedScopeRef: "thread_list_001",
        memoryType: "preference",
        contentRef: null,
        contentRedacted: content1,
        contentHash: hash1,
        candidateKey: key1,
        sensitivityClass: "internal",
        sourceHash: hash1,
        rationaleCode: "USER_EXPLICIT",
      });

      const content2 = "workspace 级记忆";
      const hash2 = computeMemoryContentHash(content2);
      const key2 = computeCandidateKey({
        invocationId: "inv_list_002",
        sourceType: "thread_item",
        sourceId: "item_list_002",
        contentHash: hash2,
        scopeType: "workspace",
        scopeRef: "ws_list_001",
      });
      await createMemoryCandidateWithEntry({
        tenantId,
        invocationId: "inv_list_002",
        sourceItemId: "item_list_002",
        proposedScopeType: "workspace",
        proposedScopeRef: "ws_list_001",
        memoryType: "preference",
        contentRef: null,
        contentRedacted: content2,
        contentHash: hash2,
        candidateKey: key2,
        sensitivityClass: "internal",
        sourceHash: hash2,
        rationaleCode: "USER_EXPLICIT",
      });

      const entries = await listActiveMemoryEntriesByScopes(
        tenantId,
        [
          { scopeType: "thread", scopeRef: "thread_list_001" },
          { scopeType: "workspace", scopeRef: "ws_list_001" },
        ],
        { limit: 10 },
      );
      expect(entries).toHaveLength(2);
      const scopeTypes = entries.map((e) => e.scopeType).sort();
      expect(scopeTypes).toEqual(["thread", "workspace"]);
    } finally {
      await cleanupTenantMemory(tenantId);
    }
  });

  it("archived Entry 不参与检索", async () => {
    const { tenantId } = await seedContext();
    try {
      const content = "待归档记忆";
      const hash = computeMemoryContentHash(content);
      const key = computeCandidateKey({
        invocationId: "inv_archive_001",
        sourceType: "thread_item",
        sourceId: "item_archive_001",
        contentHash: hash,
        scopeType: "workspace",
        scopeRef: "ws_archive_001",
      });
      const { entry } = await createMemoryCandidateWithEntry({
        tenantId,
        invocationId: "inv_archive_001",
        sourceItemId: "item_archive_001",
        proposedScopeType: "workspace",
        proposedScopeRef: "ws_archive_001",
        memoryType: "preference",
        contentRef: null,
        contentRedacted: content,
        contentHash: hash,
        candidateKey: key,
        sensitivityClass: "internal",
        sourceHash: hash,
        rationaleCode: "USER_EXPLICIT",
      });

      await archiveMemoryEntry(tenantId, entry.id);

      const entries = await listActiveMemoryEntriesByScopes(
        tenantId,
        [{ scopeType: "workspace", scopeRef: "ws_archive_001" }],
        { limit: 10 },
      );
      expect(entries).toHaveLength(0);
    } finally {
      await cleanupTenantMemory(tenantId);
    }
  });

  it("跨租户隔离", async () => {
    const { tenantId } = await seedContext();
    const otherTenantId = randomUUID();
    try {
      const content = "租户隔离测试";
      const hash = computeMemoryContentHash(content);
      const key = computeCandidateKey({
        invocationId: "inv_isolation_001",
        sourceType: "thread_item",
        sourceId: "item_isolation_001",
        contentHash: hash,
        scopeType: "workspace",
        scopeRef: "ws_isolation_001",
      });
      await createMemoryCandidateWithEntry({
        tenantId,
        invocationId: "inv_isolation_001",
        sourceItemId: "item_isolation_001",
        proposedScopeType: "workspace",
        proposedScopeRef: "ws_isolation_001",
        memoryType: "preference",
        contentRef: null,
        contentRedacted: content,
        contentHash: hash,
        candidateKey: key,
        sensitivityClass: "internal",
        sourceHash: hash,
        rationaleCode: "USER_EXPLICIT",
      });

      const entries = await listActiveMemoryEntriesByScopes(
        otherTenantId,
        [{ scopeType: "workspace", scopeRef: "ws_isolation_001" }],
        { limit: 10 },
      );
      expect(entries).toHaveLength(0);
    } finally {
      await cleanupTenantMemory(tenantId);
    }
  });

  it("空 scopes 列表返回空数组", async () => {
    const entries = await listActiveMemoryEntriesByScopes("t1", [], { limit: 10 });
    expect(entries).toHaveLength(0);
  });
});

describe("memory-queries S07-C04：listMemoryEntriesByScope（用户控制）", () => {
  it("按 scopeType + scopeRef 列出 active Entry", async () => {
    const { tenantId } = await seedContext();
    try {
      const content = "用户控制列表测试";
      const hash = computeMemoryContentHash(content);
      const key = computeCandidateKey({
        invocationId: "inv_user_list_001",
        sourceType: "thread_item",
        sourceId: "item_user_list_001",
        contentHash: hash,
        scopeType: "workspace",
        scopeRef: "ws_user_list_001",
      });
      await createMemoryCandidateWithEntry({
        tenantId,
        invocationId: "inv_user_list_001",
        sourceItemId: "item_user_list_001",
        proposedScopeType: "workspace",
        proposedScopeRef: "ws_user_list_001",
        memoryType: "preference",
        contentRef: null,
        contentRedacted: content,
        contentHash: hash,
        candidateKey: key,
        sensitivityClass: "internal",
        sourceHash: hash,
        rationaleCode: "USER_EXPLICIT",
      });

      const entries = await listMemoryEntriesByScope(tenantId, "workspace", "ws_user_list_001", {
        limit: 10,
      });
      expect(entries).toHaveLength(1);
      expect(entries[0]?.contentRedacted).toBe(content);
    } finally {
      await cleanupTenantMemory(tenantId);
    }
  });

  it("includeArchived=true 含 archived Entry", async () => {
    const { tenantId } = await seedContext();
    try {
      const content = "归档列表测试";
      const hash = computeMemoryContentHash(content);
      const key = computeCandidateKey({
        invocationId: "inv_arch_list_001",
        sourceType: "thread_item",
        sourceId: "item_arch_list_001",
        contentHash: hash,
        scopeType: "workspace",
        scopeRef: "ws_arch_list_001",
      });
      const { entry } = await createMemoryCandidateWithEntry({
        tenantId,
        invocationId: "inv_arch_list_001",
        sourceItemId: "item_arch_list_001",
        proposedScopeType: "workspace",
        proposedScopeRef: "ws_arch_list_001",
        memoryType: "preference",
        contentRef: null,
        contentRedacted: content,
        contentHash: hash,
        candidateKey: key,
        sensitivityClass: "internal",
        sourceHash: hash,
        rationaleCode: "USER_EXPLICIT",
      });
      await archiveMemoryEntry(tenantId, entry.id);

      const activeOnly = await listMemoryEntriesByScope(tenantId, "workspace", "ws_arch_list_001", {
        limit: 10,
      });
      expect(activeOnly).toHaveLength(0);

      const withArchived = await listMemoryEntriesByScope(
        tenantId,
        "workspace",
        "ws_arch_list_001",
        { limit: 10, includeArchived: true },
      );
      expect(withArchived).toHaveLength(1);
      expect(withArchived[0]?.memoryState).toBe("archived");
    } finally {
      await cleanupTenantMemory(tenantId);
    }
  });
});

describe("memory-queries S07-C04：archiveMemoryEntry / updateMemoryEntry", () => {
  it("archiveMemoryEntry：active → archived", async () => {
    const { tenantId } = await seedContext();
    try {
      const content = "待归档";
      const hash = computeMemoryContentHash(content);
      const key = computeCandidateKey({
        invocationId: "inv_arch_001",
        sourceType: "thread_item",
        sourceId: "item_arch_001",
        contentHash: hash,
        scopeType: "workspace",
        scopeRef: "ws_arch_001",
      });
      const { entry } = await createMemoryCandidateWithEntry({
        tenantId,
        invocationId: "inv_arch_001",
        sourceItemId: "item_arch_001",
        proposedScopeType: "workspace",
        proposedScopeRef: "ws_arch_001",
        memoryType: "preference",
        contentRef: null,
        contentRedacted: content,
        contentHash: hash,
        candidateKey: key,
        sensitivityClass: "internal",
        sourceHash: hash,
        rationaleCode: "USER_EXPLICIT",
      });

      const archived = await archiveMemoryEntry(tenantId, entry.id);
      expect(archived?.memoryState).toBe("archived");

      const archived2 = await archiveMemoryEntry(tenantId, entry.id);
      expect(archived2?.memoryState).toBe("archived");
    } finally {
      await cleanupTenantMemory(tenantId);
    }
  });

  it("archiveMemoryEntry：不存在返回 null", async () => {
    const { tenantId } = await seedContext();
    const result = await archiveMemoryEntry(tenantId, randomUUID());
    expect(result).toBeNull();
  });

  it("updateMemoryEntry：更新 contentRedacted 并重算 contentHash + entryKey", async () => {
    const { tenantId } = await seedContext();
    try {
      const content = "原始内容";
      const hash = computeMemoryContentHash(content);
      const key = computeCandidateKey({
        invocationId: "inv_upd_001",
        sourceType: "thread_item",
        sourceId: "item_upd_001",
        contentHash: hash,
        scopeType: "workspace",
        scopeRef: "ws_upd_001",
      });
      const { entry } = await createMemoryCandidateWithEntry({
        tenantId,
        invocationId: "inv_upd_001",
        sourceItemId: "item_upd_001",
        proposedScopeType: "workspace",
        proposedScopeRef: "ws_upd_001",
        memoryType: "preference",
        contentRef: null,
        contentRedacted: content,
        contentHash: hash,
        candidateKey: key,
        sensitivityClass: "internal",
        sourceHash: hash,
        rationaleCode: "USER_EXPLICIT",
      });

      const newContent = "用户修改后的内容";
      const newHash = computeMemoryContentHash(newContent);
      const updated = await updateMemoryEntry(tenantId, entry.id, {
        contentRedacted: newContent,
      });
      expect(updated?.contentRedacted).toBe(newContent);
      expect(updated?.contentHash).toBe(newHash);
      const expectedKey = computeMemoryEntryKey({
        tenantId,
        scopeType: "workspace",
        scopeRef: "ws_upd_001",
        memoryType: "preference",
        contentHash: newHash,
      });
      expect(updated?.entryKey).toBe(expectedKey);
    } finally {
      await cleanupTenantMemory(tenantId);
    }
  });

  it("updateMemoryEntry：更新 expiresAt", async () => {
    const { tenantId } = await seedContext();
    try {
      const content = "过期测试";
      const hash = computeMemoryContentHash(content);
      const key = computeCandidateKey({
        invocationId: "inv_exp_001",
        sourceType: "thread_item",
        sourceId: "item_exp_001",
        contentHash: hash,
        scopeType: "workspace",
        scopeRef: "ws_exp_001",
      });
      const { entry } = await createMemoryCandidateWithEntry({
        tenantId,
        invocationId: "inv_exp_001",
        sourceItemId: "item_exp_001",
        proposedScopeType: "workspace",
        proposedScopeRef: "ws_exp_001",
        memoryType: "preference",
        contentRef: null,
        contentRedacted: content,
        contentHash: hash,
        candidateKey: key,
        sensitivityClass: "internal",
        sourceHash: hash,
        rationaleCode: "USER_EXPLICIT",
      });

      const expiresAt = new Date("2027-01-01T00:00:00Z");
      const updated = await updateMemoryEntry(tenantId, entry.id, { expiresAt });
      expect(updated?.expiresAt?.toISOString()).toBe(expiresAt.toISOString());
    } finally {
      await cleanupTenantMemory(tenantId);
    }
  });

  it("updateMemoryEntry：不存在返回 null", async () => {
    const { tenantId } = await seedContext();
    const result = await updateMemoryEntry(tenantId, randomUUID(), {
      contentRedacted: "x",
    });
    expect(result).toBeNull();
  });
});

describe("memory-queries S07-C04：migrateThreadPinnedFacts", () => {
  it("空 pinnedFacts → skipped（empty_facts）", async () => {
    const { tenantId } = await seedContext();
    const result = await migrateThreadPinnedFacts({
      tenantId,
      threadId: "thread_migrate_empty",
      pinnedFacts: null,
    });
    expect(result.migratedCount).toBe(0);
    expect(result.reasonCodes).toContain("empty_facts");
  });

  it("正常迁移：每条 fact 创建 thread scope Entry", async () => {
    const { tenantId } = await seedContext();
    try {
      const result = await migrateThreadPinnedFacts({
        tenantId,
        threadId: "thread_migrate_001",
        pinnedFacts: ["事实 1", "事实 2", "事实 3"],
      });
      expect(result.migratedCount).toBe(3);
      expect(result.skippedCount).toBe(0);

      const entries = await listMemoryEntriesByScope(tenantId, "thread", "thread_migrate_001", {
        limit: 10,
      });
      expect(entries).toHaveLength(3);
      expect(entries.every((e) => e.memoryType === "pinned_fact")).toBe(true);
    } finally {
      await cleanupTenantMemory(tenantId);
    }
  });

  it("幂等：重复迁移不重复创建", async () => {
    const { tenantId } = await seedContext();
    try {
      const facts = ["幂等事实"];
      const r1 = await migrateThreadPinnedFacts({
        tenantId,
        threadId: "thread_migrate_idempotent",
        pinnedFacts: facts,
      });
      expect(r1.migratedCount).toBe(1);

      const r2 = await migrateThreadPinnedFacts({
        tenantId,
        threadId: "thread_migrate_idempotent",
        pinnedFacts: facts,
      });
      expect(r2.migratedCount).toBe(0);
      expect(r2.skippedCount).toBe(1);
    } finally {
      await cleanupTenantMemory(tenantId);
    }
  });

  it("敏感内容 → sensitivityClass=restricted", async () => {
    const { tenantId } = await seedContext();
    try {
      const result = await migrateThreadPinnedFacts({
        tenantId,
        threadId: "thread_migrate_sensitive",
        pinnedFacts: ["password=admin1234"],
      });
      expect(result.migratedCount).toBe(1);

      const entries = await listMemoryEntriesByScope(
        tenantId,
        "thread",
        "thread_migrate_sensitive",
        { limit: 10 },
      );
      expect(entries).toHaveLength(1);
      expect(entries[0]?.sensitivityClass).toBe("restricted");
    } finally {
      await cleanupTenantMemory(tenantId);
    }
  });
});

describe("S07-C04 Employee API：GET /api/v1/memory-entries（列表）", () => {
  it("dev 模式无身份头 → 200 + 默认用户记忆列表", async () => {
    const { tenantId } = await seedContext();
    try {
      const content = "用户偏好列表测试";
      const hash = computeMemoryContentHash(content);
      const key = computeCandidateKey({
        invocationId: "inv_emp_list_001",
        sourceType: "thread_item",
        sourceId: "item_emp_list_001",
        contentHash: hash,
        scopeType: "user_preference",
      });
      await createMemoryCandidateWithEntry({
        tenantId,
        invocationId: "inv_emp_list_001",
        sourceItemId: "item_emp_list_001",
        proposedScopeType: "user_preference",
        proposedScopeRef: null,
        memoryType: "preference",
        contentRef: null,
        contentRedacted: content,
        contentHash: hash,
        candidateKey: key,
        sensitivityClass: "internal",
        sourceHash: hash,
        rationaleCode: "USER_EXPLICIT",
      });

      const request = buildV11Request({
        audience: "employee",
        method: "GET",
        path: "/memory-entries",
      });
      const response = await memoryEntryListGET(request);
      expect(response.status).toBe(200);
      const body = await response.json();
      expect(Array.isArray(body.entries)).toBe(true);
      expect(body.entries.length).toBeGreaterThanOrEqual(1);
      const found = body.entries.find(
        (e: { content_redacted: string }) => e.content_redacted === content,
      );
      expect(found).toBeDefined();
    } finally {
      await cleanupTenantMemory(tenantId);
    }
  });

  it("按 scope_type + scope_ref 过滤", async () => {
    const { tenantId } = await seedContext();
    try {
      const content = "workspace 过滤测试";
      const hash = computeMemoryContentHash(content);
      const key = computeCandidateKey({
        invocationId: "inv_emp_filter_001",
        sourceType: "thread_item",
        sourceId: "item_emp_filter_001",
        contentHash: hash,
        scopeType: "workspace",
        scopeRef: "ws_emp_filter_001",
      });
      await createMemoryCandidateWithEntry({
        tenantId,
        invocationId: "inv_emp_filter_001",
        sourceItemId: "item_emp_filter_001",
        proposedScopeType: "workspace",
        proposedScopeRef: "ws_emp_filter_001",
        memoryType: "preference",
        contentRef: null,
        contentRedacted: content,
        contentHash: hash,
        candidateKey: key,
        sensitivityClass: "internal",
        sourceHash: hash,
        rationaleCode: "USER_EXPLICIT",
      });

      const request = buildV11Request({
        audience: "employee",
        method: "GET",
        path: "/memory-entries?scope_type=workspace&scope_ref=ws_emp_filter_001",
      });
      const response = await memoryEntryListGET(request);
      expect(response.status).toBe(200);
      const body = await response.json();
      expect(body.entries).toHaveLength(1);
      expect(body.entries[0].scope).toEqual({
        type: "workspace",
        ref: "ws_emp_filter_001",
      });
    } finally {
      await cleanupTenantMemory(tenantId);
    }
  });

  it("非法 scope_type → 400", async () => {
    const request = buildV11Request({
      audience: "employee",
      method: "GET",
      path: "/memory-entries?scope_type=invalid_scope",
    });
    const response = await memoryEntryListGET(request);
    expect(response.status).toBe(400);
  });

  it("restricted sensitivity 不回显正文", async () => {
    const { tenantId } = await seedContext();
    try {
      await migrateThreadPinnedFacts({
        tenantId,
        threadId: "thread_restricted_list",
        pinnedFacts: ["password=secret1234"],
      });

      const request = buildV11Request({
        audience: "employee",
        method: "GET",
        path: "/memory-entries?scope_type=thread&scope_ref=thread_restricted_list",
      });
      const response = await memoryEntryListGET(request);
      expect(response.status).toBe(200);
      const body = await response.json();
      expect(body.entries).toHaveLength(1);
      expect(body.entries[0].content_redacted).toBeNull();
      expect(body.entries[0].sensitivity_class).toBe("restricted");
    } finally {
      await cleanupTenantMemory(tenantId);
    }
  });
});

describe("S07-C04 Employee API：GET/PATCH/DELETE /api/v1/memory-entries/{id}", () => {
  it("GET：查询单个 Entry", async () => {
    const { tenantId } = await seedContext();
    try {
      const content = "单个查询测试";
      const hash = computeMemoryContentHash(content);
      const key = computeCandidateKey({
        invocationId: "inv_emp_get_001",
        sourceType: "thread_item",
        sourceId: "item_emp_get_001",
        contentHash: hash,
        scopeType: "workspace",
        scopeRef: "ws_emp_get_001",
      });
      const { entry } = await createMemoryCandidateWithEntry({
        tenantId,
        invocationId: "inv_emp_get_001",
        sourceItemId: "item_emp_get_001",
        proposedScopeType: "workspace",
        proposedScopeRef: "ws_emp_get_001",
        memoryType: "preference",
        contentRef: null,
        contentRedacted: content,
        contentHash: hash,
        candidateKey: key,
        sensitivityClass: "internal",
        sourceHash: hash,
        rationaleCode: "USER_EXPLICIT",
      });

      const request = buildV11Request({
        audience: "employee",
        method: "GET",
        path: `/memory-entries/${entry.id}`,
      });
      const response = await memoryEntryGET(request);
      expect(response.status).toBe(200);
      const body = await response.json();
      expect(body.entry_id).toBe(entry.id);
      expect(body.content_redacted).toBe(content);
    } finally {
      await cleanupTenantMemory(tenantId);
    }
  });

  it("GET：不存在 → 404", async () => {
    const request = buildV11Request({
      audience: "employee",
      method: "GET",
      path: `/memory-entries/${randomUUID()}`,
    });
    const response = await memoryEntryGET(request);
    expect(response.status).toBe(404);
  });

  it("PATCH：更新 content_redacted", async () => {
    const { tenantId } = await seedContext();
    try {
      const content = "PATCH 原始";
      const hash = computeMemoryContentHash(content);
      const key = computeCandidateKey({
        invocationId: "inv_emp_patch_001",
        sourceType: "thread_item",
        sourceId: "item_emp_patch_001",
        contentHash: hash,
        scopeType: "workspace",
        scopeRef: "ws_emp_patch_001",
      });
      const { entry } = await createMemoryCandidateWithEntry({
        tenantId,
        invocationId: "inv_emp_patch_001",
        sourceItemId: "item_emp_patch_001",
        proposedScopeType: "workspace",
        proposedScopeRef: "ws_emp_patch_001",
        memoryType: "preference",
        contentRef: null,
        contentRedacted: content,
        contentHash: hash,
        candidateKey: key,
        sensitivityClass: "internal",
        sourceHash: hash,
        rationaleCode: "USER_EXPLICIT",
      });

      const newContent = "PATCH 修改后";
      const request = buildV11Request({
        audience: "employee",
        method: "PATCH",
        path: `/memory-entries/${entry.id}`,
        body: { content_redacted: newContent },
      });
      const response = await memoryEntryPATCH(request);
      expect(response.status).toBe(200);
      const body = await response.json();
      expect(body.content_redacted).toBe(newContent);
      expect(body.content_hash).toBe(computeMemoryContentHash(newContent));
    } finally {
      await cleanupTenantMemory(tenantId);
    }
  });

  it("PATCH：非法请求体 → 400", async () => {
    const { tenantId } = await seedContext();
    try {
      const content = "PATCH 非法";
      const hash = computeMemoryContentHash(content);
      const key = computeCandidateKey({
        invocationId: "inv_emp_patch_inv_001",
        sourceType: "thread_item",
        sourceId: "item_emp_patch_inv_001",
        contentHash: hash,
        scopeType: "workspace",
        scopeRef: "ws_emp_patch_inv_001",
      });
      const { entry } = await createMemoryCandidateWithEntry({
        tenantId,
        invocationId: "inv_emp_patch_inv_001",
        sourceItemId: "item_emp_patch_inv_001",
        proposedScopeType: "workspace",
        proposedScopeRef: "ws_emp_patch_inv_001",
        memoryType: "preference",
        contentRef: null,
        contentRedacted: content,
        contentHash: hash,
        candidateKey: key,
        sensitivityClass: "internal",
        sourceHash: hash,
        rationaleCode: "USER_EXPLICIT",
      });

      const request = buildV11Request({
        audience: "employee",
        method: "PATCH",
        path: `/memory-entries/${entry.id}`,
        body: { content_redacted: "" },
      });
      const response = await memoryEntryPATCH(request);
      expect(response.status).toBe(400);
    } finally {
      await cleanupTenantMemory(tenantId);
    }
  });

  it("DELETE：归档 Entry（不物理删除）", async () => {
    const { tenantId } = await seedContext();
    try {
      const content = "DELETE 归档测试";
      const hash = computeMemoryContentHash(content);
      const key = computeCandidateKey({
        invocationId: "inv_emp_del_001",
        sourceType: "thread_item",
        sourceId: "item_emp_del_001",
        contentHash: hash,
        scopeType: "workspace",
        scopeRef: "ws_emp_del_001",
      });
      const { entry } = await createMemoryCandidateWithEntry({
        tenantId,
        invocationId: "inv_emp_del_001",
        sourceItemId: "item_emp_del_001",
        proposedScopeType: "workspace",
        proposedScopeRef: "ws_emp_del_001",
        memoryType: "preference",
        contentRef: null,
        contentRedacted: content,
        contentHash: hash,
        candidateKey: key,
        sensitivityClass: "internal",
        sourceHash: hash,
        rationaleCode: "USER_EXPLICIT",
      });

      const request = buildV11Request({
        audience: "employee",
        method: "DELETE",
        path: `/memory-entries/${entry.id}`,
      });
      const response = await memoryEntryDELETE(request);
      expect(response.status).toBe(200);
      const body = await response.json();
      expect(body.memory_state).toBe("archived");

      const stillExists = await getMemoryEntryById(tenantId, entry.id);
      expect(stillExists).not.toBeNull();
      expect(stillExists?.memoryState).toBe("archived");
    } finally {
      await cleanupTenantMemory(tenantId);
    }
  });

  it("DELETE：不存在 → 404", async () => {
    const request = buildV11Request({
      audience: "employee",
      method: "DELETE",
      path: `/memory-entries/${randomUUID()}`,
    });
    const response = await memoryEntryDELETE(request);
    expect(response.status).toBe(404);
  });
});

describe("S07-C04 MemoryResolver：分作用域检索", () => {
  it("按 ctx 构造 scopes 并返回 memory Fragment", async () => {
    const { tenantId } = await seedContext();
    try {
      const content = "MemoryResolver 检索测试";
      const hash = computeMemoryContentHash(content);
      const key = computeCandidateKey({
        invocationId: "inv_resolver_001",
        sourceType: "thread_item",
        sourceId: "item_resolver_001",
        contentHash: hash,
        scopeType: "workspace",
        scopeRef: "ws_resolver_001",
      });
      await createMemoryCandidateWithEntry({
        tenantId,
        invocationId: "inv_resolver_001",
        sourceItemId: "item_resolver_001",
        proposedScopeType: "workspace",
        proposedScopeRef: "ws_resolver_001",
        memoryType: "preference",
        contentRef: null,
        contentRedacted: content,
        contentHash: hash,
        candidateKey: key,
        sensitivityClass: "internal",
        sourceHash: hash,
        rationaleCode: "USER_EXPLICIT",
      });

      const resolver = new MemoryResolver(10);
      const result = await resolver.resolve({
        tenantId,
        invocationId: "inv_resolver_test",
        workspaceId: "ws_resolver_001",
      });
      expect(result.status).toBe("ok");
      expect(result.sourceType).toBe("memory");
      expect(result.fragments.length).toBeGreaterThanOrEqual(1);
      const frag = result.fragments.find((f) => f.text === content);
      expect(frag).toBeDefined();
      expect(frag?.kind).toBe("memory");
      expect(frag?.scope).toBe("project");
      expect(frag?.id).toBeDefined();
    } finally {
      await cleanupTenantMemory(tenantId);
    }
  });

  it("无匹配 → empty", async () => {
    const { tenantId } = await seedContext();
    const resolver = new MemoryResolver(10);
    const result = await resolver.resolve({
      tenantId,
      invocationId: "inv_resolver_empty",
    });
    expect(result.status).toBe("empty");
    expect(result.reasonCode).toBe("no_active_memory");
  });

  it("restricted sensitivity 不返回正文", async () => {
    const { tenantId } = await seedContext();
    try {
      await migrateThreadPinnedFacts({
        tenantId,
        threadId: "thread_resolver_restricted",
        pinnedFacts: ["password=secret1234"],
      });

      const resolver = new MemoryResolver(10);
      const result = await resolver.resolve({
        tenantId,
        invocationId: "inv_resolver_restricted",
        threadId: "thread_resolver_restricted",
      });
      expect(result.status).toBe("ok");
      const frag = result.fragments[0];
      expect(frag).toBeDefined();
      expect(frag?.sensitivity).toBe("restricted");
      expect(frag?.text).toBeUndefined();
    } finally {
      await cleanupTenantMemory(tenantId);
    }
  });

  it("allowedSources 不含 memory → denied", async () => {
    const resolver = new MemoryResolver(10);
    const result = await resolver.resolve({
      tenantId: "t1",
      invocationId: "inv_denied",
      allowedSources: ["recent_items"],
    });
    expect(result.status).toBe("denied");
    expect(result.reasonCode).toBe("source_not_authorized");
  });
});
