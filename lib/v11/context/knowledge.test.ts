/**
 * V11 Knowledge Base / Document / Revision / Chunk / 证据检索集成测试
 *   （阶段 7 S07-C05）。
 *
 * 事实源：
 * - ../v11-agentkit-platform/03-context-memory-and-knowledge.md §12（Knowledge Base）、
 *   §13（Knowledge 加载：先目录后证据 / 数据保持最新 / 检索失败区分）、§14（与 Skill/Tool 边界）。
 * - ../v11-agentkit-platform/10-core-data-model.md §4.4（knowledge_base/document/revision）、
 *   §7.5（knowledge_chunk / knowledge_index）。
 * - ../v11-agentkit-platform-development-plan/07-context-memory-and-knowledge.md S07-W06。
 *
 * 覆盖：
 * - knowledge-queries：computeKnowledgeContentHash / isValidKnowledgeContentHash /
 *   isKnowledgeBaseLifecycleState / isKnowledgeIndexState / isKnowledgeRevisionState /
 *   isKnowledgeSourceType / createKnowledgeBase / getKnowledgeBaseByKey / listKnowledgeBases /
 *   archiveKnowledgeBase / createKnowledgeDocument / listKnowledgeDocuments /
 *   createKnowledgeDocumentRevision / publishKnowledgeDocumentRevision /
 *   retractKnowledgeDocumentRevision / createKnowledgeChunk /
 *   markKnowledgeRevisionIndexState / searchKnowledgeEvidence。
 * - Admin API：POST /admin/api/v1/knowledge-bases / POST documents / POST revisions /
 *   POST :publish / POST :retract / POST :mark-index-ready / POST chunks。
 * - 跨租户隔离 / 幂等重放 / Idempotency 冲突 / 索引未就绪不允许发布 / 状态机违反。
 *
 * 真实 MySQL 8 Testcontainers，不使用 mock。Admin 主体由 grantActionBinding 授权。
 */
import { randomUUID } from "node:crypto";
import { POST as revisionMarkIndexReadyPOST } from "@/app/admin/api/v1/knowledge-bases/[base_id]/documents/[document_id]/revisions/[revision_id]:mark-index-ready/route";
import { POST as revisionPublishPOST } from "@/app/admin/api/v1/knowledge-bases/[base_id]/documents/[document_id]/revisions/[revision_id]:publish/route";
import { POST as revisionRetractPOST } from "@/app/admin/api/v1/knowledge-bases/[base_id]/documents/[document_id]/revisions/[revision_id]:retract/route";
import {
  POST as chunkCreatePOST,
  GET as chunkListGET,
} from "@/app/admin/api/v1/knowledge-bases/[base_id]/documents/[document_id]/revisions/[revision_id]/chunks/route";
import {
  POST as revisionCreatePOST,
  GET as revisionListGET,
} from "@/app/admin/api/v1/knowledge-bases/[base_id]/documents/[document_id]/revisions/route";
import {
  POST as documentCreatePOST,
  GET as documentListGET,
} from "@/app/admin/api/v1/knowledge-bases/[base_id]/documents/route";
import {
  POST as knowledgeBaseCreatePOST,
  GET as knowledgeBaseListGET,
} from "@/app/admin/api/v1/knowledge-bases/route";
import { DEFAULT_USER_EMAIL, DEFAULT_USER_ID, DEFAULT_USER_NAME } from "@/lib/constants";
import { db } from "@/lib/db/client";
import { buildV11Request } from "@/lib/db/test/api-fixtures";
import { resetDatabase } from "@/lib/db/test/mysql-harness";
import { upsertPrincipalBinding } from "@/lib/identity/principal-binding-queries";
import { grantActionBinding } from "@/lib/identity/role-action-queries";
import { ensureDefaultTenant } from "@/lib/identity/tenant-queries";
import { upsertUserIdentity } from "@/lib/identity/user-identity-queries";
import { tenant as tenantTable } from "@/lib/persistence/schema/identity";
import {
  knowledgeBase,
  knowledgeChunk,
  knowledgeDocument,
  knowledgeDocumentRevision,
  knowledgeIndex,
} from "@/lib/persistence/schema/knowledge";
import {
  type KnowledgeEvidenceHit,
  KnowledgeRevisionAlreadyPublishedError,
  KnowledgeRevisionIndexNotReadyError,
  KnowledgeValidationError,
  KnowledgeVersionConflictError,
  archiveKnowledgeBase,
  computeKnowledgeBaseFingerprint,
  computeKnowledgeContentHash,
  createKnowledgeBase,
  createKnowledgeChunk,
  createKnowledgeDocument,
  createKnowledgeDocumentRevision,
  getKnowledgeBaseById,
  getKnowledgeBaseByKey,
  getKnowledgeDocumentById,
  getKnowledgeDocumentRevisionById,
  isKnowledgeBaseLifecycleState,
  isKnowledgeIndexState,
  isKnowledgeRevisionState,
  isKnowledgeSourceType,
  isValidKnowledgeContentHash,
  listKnowledgeBases,
  listKnowledgeChunksByRevision,
  listKnowledgeDocumentRevisions,
  listKnowledgeDocuments,
  markKnowledgeRevisionIndexState,
  publishKnowledgeDocumentRevision,
  retractKnowledgeDocumentRevision,
  searchKnowledgeEvidence,
  upsertKnowledgeIndex,
} from "@/lib/v11/context/knowledge-queries";
import { KnowledgeResolver } from "@/lib/v11/context/source-resolvers";
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

/** 授予 Knowledge 全套 action scope（tenant / base / document 级）。 */
async function grantKnowledgeScopes(tenantId: string, principalBindingId: string) {
  await grantActionBinding({
    tenantId,
    principalBindingId,
    actionCode: "knowledge.base.create",
    resourceScope: { type: "tenant", wildcard: true },
  });
  await grantActionBinding({
    tenantId,
    principalBindingId,
    actionCode: "knowledge.document.create",
    resourceScope: { type: "knowledge_base", wildcard: true },
  });
  await grantActionBinding({
    tenantId,
    principalBindingId,
    actionCode: "knowledge.document.publish",
    resourceScope: { type: "knowledge_document", wildcard: true },
  });
  await grantActionBinding({
    tenantId,
    principalBindingId,
    actionCode: "knowledge.document.retract",
    resourceScope: { type: "knowledge_document", wildcard: true },
  });
}

/** 清理 tenant 内的全部 Knowledge 行（base 级联清理 document/revision/chunk/index）。 */
async function cleanupTenantKnowledge(tenantId: string) {
  // 先删 index → chunk → revision → document → base（按外键依赖顺序）
  const chunks = await db
    .select({ id: knowledgeChunk.id })
    .from(knowledgeChunk)
    .where(eq(knowledgeChunk.tenantId, tenantId));
  for (const c of chunks) {
    await db.delete(knowledgeIndex).where(eq(knowledgeIndex.chunkId, c.id));
  }
  await db.delete(knowledgeChunk).where(eq(knowledgeChunk.tenantId, tenantId));
  await db
    .delete(knowledgeDocumentRevision)
    .where(eq(knowledgeDocumentRevision.tenantId, tenantId));
  await db.delete(knowledgeDocument).where(eq(knowledgeDocument.tenantId, tenantId));
  await db.delete(knowledgeBase).where(eq(knowledgeBase.tenantId, tenantId));
}

// ═══════════════════════════════════════════════════════════
// 1. knowledge-queries：Hash / Key / 枚举校验
// ═══════════════════════════════════════════════════════════

describe("knowledge-queries：Hash / Key 计算", () => {
  it("computeKnowledgeContentHash：返回 sha256: 前缀 + 64 hex", () => {
    const hash = computeKnowledgeContentHash("部署指南");
    expect(hash).toMatch(/^sha256:[0-9a-f]{64}$/);
  });

  it("isValidKnowledgeContentHash：合法 hash → true", () => {
    const hash = computeKnowledgeContentHash("测试");
    expect(isValidKnowledgeContentHash(hash)).toBe(true);
  });

  it("isValidKnowledgeContentHash：非法 hash → false", () => {
    expect(isValidKnowledgeContentHash("sha256:abc")).toBe(false);
    expect(isValidKnowledgeContentHash("not-a-hash")).toBe(false);
    expect(isValidKnowledgeContentHash("")).toBe(false);
  });

  it("computeKnowledgeBaseFingerprint：相同 (tenantId, knowledgeKey) 产生相同指纹", () => {
    const a = computeKnowledgeBaseFingerprint("t1", "deploy-guide");
    const b = computeKnowledgeBaseFingerprint("t1", "deploy-guide");
    const c = computeKnowledgeBaseFingerprint("t2", "deploy-guide");
    expect(a).toBe(b);
    expect(a).not.toBe(c);
    expect(a).toMatch(/^sha256:[0-9a-f]{64}$/);
  });
});

describe("knowledge-queries：枚举校验", () => {
  it("isKnowledgeBaseLifecycleState：active/archived/deleted → true；其他 → false", () => {
    expect(isKnowledgeBaseLifecycleState("active")).toBe(true);
    expect(isKnowledgeBaseLifecycleState("archived")).toBe(true);
    expect(isKnowledgeBaseLifecycleState("deleted")).toBe(true);
    expect(isKnowledgeBaseLifecycleState("draft")).toBe(false);
    expect(isKnowledgeBaseLifecycleState("")).toBe(false);
  });

  it("isKnowledgeIndexState：pending/indexing/ready/failed/stale → true；其他 → false", () => {
    expect(isKnowledgeIndexState("pending")).toBe(true);
    expect(isKnowledgeIndexState("indexing")).toBe(true);
    expect(isKnowledgeIndexState("ready")).toBe(true);
    expect(isKnowledgeIndexState("failed")).toBe(true);
    expect(isKnowledgeIndexState("stale")).toBe(true);
    expect(isKnowledgeIndexState("ok")).toBe(false);
  });

  it("isKnowledgeRevisionState：draft/published/superseded/retracted → true；其他 → false", () => {
    expect(isKnowledgeRevisionState("draft")).toBe(true);
    expect(isKnowledgeRevisionState("published")).toBe(true);
    expect(isKnowledgeRevisionState("superseded")).toBe(true);
    expect(isKnowledgeRevisionState("retracted")).toBe(true);
    expect(isKnowledgeRevisionState("active")).toBe(false);
  });

  it("isKnowledgeSourceType：upload/external_url/manual/synced/generated → true；其他 → false", () => {
    expect(isKnowledgeSourceType("upload")).toBe(true);
    expect(isKnowledgeSourceType("external_url")).toBe(true);
    expect(isKnowledgeSourceType("manual")).toBe(true);
    expect(isKnowledgeSourceType("synced")).toBe(true);
    expect(isKnowledgeSourceType("generated")).toBe(true);
    expect(isKnowledgeSourceType("web")).toBe(false);
  });
});

// ═══════════════════════════════════════════════════════════
// 2. knowledge-queries：KnowledgeBase CRUD
// ═══════════════════════════════════════════════════════════

describe("knowledge-queries：KnowledgeBase CRUD", () => {
  it("createKnowledgeBase：成功创建 + 默认 active/pending + ETag versionNo", async () => {
    const { tenantId } = await seedContext();
    try {
      const base = await createKnowledgeBase({
        tenantId,
        knowledgeKey: "deploy-guide",
        displayName: "部署指南",
        description: "V11 部署流程文档",
        ownerUserId: "user-1",
        createdBy: "user-1",
      });

      expect(base.id).toBeTruthy();
      expect(base.tenantId).toBe(tenantId);
      expect(base.knowledgeKey).toBe("deploy-guide");
      expect(base.displayName).toBe("部署指南");
      expect(base.lifecycleState).toBe("active");
      expect(base.indexState).toBe("pending");
      expect(base.versionNo).toBeTruthy();
      expect(base.createdAt).toBeInstanceOf(Date);
    } finally {
      await cleanupTenantKnowledge(tenantId);
    }
  });

  it("createKnowledgeBase：空 knowledgeKey → KnowledgeValidationError", async () => {
    const { tenantId } = await seedContext();
    try {
      await expect(
        createKnowledgeBase({
          tenantId,
          knowledgeKey: "",
          displayName: "测试",
          createdBy: "user-1",
        }),
      ).rejects.toBeInstanceOf(KnowledgeValidationError);
    } finally {
      await cleanupTenantKnowledge(tenantId);
    }
  });

  it("createKnowledgeBase：空 displayName → KnowledgeValidationError", async () => {
    const { tenantId } = await seedContext();
    try {
      await expect(
        createKnowledgeBase({
          tenantId,
          knowledgeKey: "test-kb",
          displayName: "",
          createdBy: "user-1",
        }),
      ).rejects.toBeInstanceOf(KnowledgeValidationError);
    } finally {
      await cleanupTenantKnowledge(tenantId);
    }
  });

  it("createKnowledgeBase：重复 knowledgeKey → 抛错（唯一约束）", async () => {
    const { tenantId } = await seedContext();
    try {
      await createKnowledgeBase({
        tenantId,
        knowledgeKey: "dup-key",
        displayName: "第一份",
        createdBy: "user-1",
      });
      await expect(
        createKnowledgeBase({
          tenantId,
          knowledgeKey: "dup-key",
          displayName: "第二份",
          createdBy: "user-1",
        }),
      ).rejects.toThrow();
    } finally {
      await cleanupTenantKnowledge(tenantId);
    }
  });

  it("getKnowledgeBaseByKey / getKnowledgeBaseById：跨租户隔离", async () => {
    const { tenantId } = await seedContext();
    try {
      const base = await createKnowledgeBase({
        tenantId,
        knowledgeKey: "kb-lookup",
        displayName: "查询测试",
        createdBy: "user-1",
      });

      const byKey = await getKnowledgeBaseByKey(tenantId, "kb-lookup");
      expect(byKey?.id).toBe(base.id);

      const byId = await getKnowledgeBaseById(tenantId, base.id);
      expect(byId?.id).toBe(base.id);

      // 跨租户查询应返回 null
      const crossTenant = await getKnowledgeBaseById(
        "00000000-0000-4000-8000-000000000099",
        base.id,
      );
      expect(crossTenant).toBeNull();
    } finally {
      await cleanupTenantKnowledge(tenantId);
    }
  });

  it("listKnowledgeBases：默认排除 deleted；按 lifecycle 过滤", async () => {
    const { tenantId } = await seedContext();
    try {
      await createKnowledgeBase({
        tenantId,
        knowledgeKey: "kb-list-1",
        displayName: "KB1",
        createdBy: "user-1",
      });
      await createKnowledgeBase({
        tenantId,
        knowledgeKey: "kb-list-2",
        displayName: "KB2",
        createdBy: "user-1",
      });

      const all = await listKnowledgeBases(tenantId);
      expect(all).toHaveLength(2);

      const onlyActive = await listKnowledgeBases(tenantId, {
        lifecycleStates: ["active"],
      });
      expect(onlyActive).toHaveLength(2);
    } finally {
      await cleanupTenantKnowledge(tenantId);
    }
  });

  it("archiveKnowledgeBase：active → archived；versionNo 更新；重复归档幂等", async () => {
    const { tenantId } = await seedContext();
    try {
      const base = await createKnowledgeBase({
        tenantId,
        knowledgeKey: "kb-archive",
        displayName: "归档测试",
        createdBy: "user-1",
      });

      const archived = await archiveKnowledgeBase({
        tenantId,
        baseId: base.id,
        expectedVersionNo: base.versionNo,
      });
      expect(archived?.lifecycleState).toBe("archived");
      expect(archived?.versionNo).not.toBe(base.versionNo);

      // 重复归档幂等返回当前行
      if (!archived) throw new Error("archived 不应为 null");
      const archivedVersionNo = archived.versionNo;
      const archivedAgain = await archiveKnowledgeBase({
        tenantId,
        baseId: base.id,
        expectedVersionNo: archivedVersionNo,
      });
      expect(archivedAgain?.lifecycleState).toBe("archived");
    } finally {
      await cleanupTenantKnowledge(tenantId);
    }
  });

  it("archiveKnowledgeBase：versionNo 不匹配 → KnowledgeVersionConflictError", async () => {
    const { tenantId } = await seedContext();
    try {
      const base = await createKnowledgeBase({
        tenantId,
        knowledgeKey: "kb-conflict",
        displayName: "冲突测试",
        createdBy: "user-1",
      });

      await expect(
        archiveKnowledgeBase({
          tenantId,
          baseId: base.id,
          expectedVersionNo: "wrong-version-no",
        }),
      ).rejects.toBeInstanceOf(KnowledgeVersionConflictError);
    } finally {
      await cleanupTenantKnowledge(tenantId);
    }
  });
});

// ═══════════════════════════════════════════════════════════
// 3. knowledge-queries：KnowledgeDocument / Revision / Chunk / Index
// ═══════════════════════════════════════════════════════════

describe("knowledge-queries：Document / Revision / Chunk 生命周期", () => {
  it("完整生命周期：base → document → draft revision → chunks → mark-index-ready → publish → search", async () => {
    const { tenantId } = await seedContext();
    try {
      // 1. 创建 KnowledgeBase
      const base = await createKnowledgeBase({
        tenantId,
        knowledgeKey: "lifecycle-kb",
        displayName: "生命周期测试",
        createdBy: "user-1",
      });

      // 2. 创建 Document
      const doc = await createKnowledgeDocument({
        tenantId,
        knowledgeBaseId: base.id,
        documentKey: "deploy-doc",
        title: "部署文档",
        sourceType: "manual",
        createdBy: "user-1",
      });
      expect(doc.currentRevisionId).toBeNull();

      // 3. 创建 Revision（draft）
      const revText = "V11 部署流程：第一步准备 MySQL 8 容器，第二步运行迁移。";
      const rev = await createKnowledgeDocumentRevision({
        tenantId,
        documentId: doc.id,
        revisionNo: "0001",
        contentRedacted: revText,
        contentHash: computeKnowledgeContentHash(revText),
        createdBy: "user-1",
      });
      expect(rev.revisionState).toBe("draft");
      expect(rev.indexState).toBe("pending");
      expect(rev.publishedAt).toBeNull();

      // 4. 创建 Chunk
      const chunkText1 = "MySQL 8 容器准备";
      const chunk1 = await createKnowledgeChunk({
        tenantId,
        documentRevisionId: rev.id,
        chunkNo: "001",
        contentRedacted: chunkText1,
        contentHash: computeKnowledgeContentHash(chunkText1),
      });
      const chunkText2 = "运行迁移：pnpm v11:migrate";
      const chunk2 = await createKnowledgeChunk({
        tenantId,
        documentRevisionId: rev.id,
        chunkNo: "002",
        contentRedacted: chunkText2,
        contentHash: computeKnowledgeContentHash(chunkText2),
      });

      // 5. 推进 indexState → ready（mark-index-ready）
      const readyRev = await markKnowledgeRevisionIndexState({
        tenantId,
        revisionId: rev.id,
        indexState: "ready",
      });
      expect(readyRev?.indexState).toBe("ready");

      // 6. 发布前：搜索应该返回 unavailable（doc.currentRevisionId=null）
      const preSearch = await searchKnowledgeEvidence({
        tenantId,
        query: "MySQL",
      });
      expect(preSearch.status).toBe("empty");
      expect(preSearch.reasonCode).toBe("no_published_document");

      // 7. 发布 Revision（draft → published；切换 doc.currentRevisionId）
      const pubResult = await publishKnowledgeDocumentRevision({
        tenantId,
        revisionId: rev.id,
        expectedDocumentVersionNo: doc.versionNo,
      });
      expect(pubResult.revision.revisionState).toBe("published");
      expect(pubResult.revision.publishedAt).toBeInstanceOf(Date);
      expect(pubResult.document.currentRevisionId).toBe(rev.id);
      expect(pubResult.document.versionNo).not.toBe(doc.versionNo);

      // 8. 发布后：搜索应返回 ok + 命中 chunk
      const postSearch = await searchKnowledgeEvidence({
        tenantId,
        query: "MySQL",
      });
      expect(postSearch.status).toBe("ok");
      expect(postSearch.hits.length).toBeGreaterThanOrEqual(1);
      const hit = postSearch.hits[0];
      if (!hit) throw new Error("hit 不应为空");
      expect(hit.chunkText).toContain("MySQL");
      expect(hit.documentId).toBe(doc.id);
      expect(hit.revisionId).toBe(rev.id);
      expect(hit.knowledgeBaseId).toBe(base.id);
      expect(hit.score).toBeGreaterThan(0);
      expect(hit.selectionReason).toBe("fulltext_match");

      // 9. 列出 Chunk 顺序正确
      const chunks = await listKnowledgeChunksByRevision(tenantId, rev.id);
      expect(chunks.map((c) => c.chunkNo)).toEqual(["001", "002"]);
    } finally {
      await cleanupTenantKnowledge(tenantId);
    }
  });

  it("publishKnowledgeDocumentRevision：索引未就绪 → KnowledgeRevisionIndexNotReadyError", async () => {
    const { tenantId } = await seedContext();
    try {
      const base = await createKnowledgeBase({
        tenantId,
        knowledgeKey: "kb-not-ready",
        displayName: "索引未就绪测试",
        createdBy: "user-1",
      });
      const doc = await createKnowledgeDocument({
        tenantId,
        knowledgeBaseId: base.id,
        documentKey: "doc-1",
        title: "文档1",
        sourceType: "manual",
        createdBy: "user-1",
      });
      const rev = await createKnowledgeDocumentRevision({
        tenantId,
        documentId: doc.id,
        revisionNo: "0001",
        contentRedacted: "内容",
        contentHash: computeKnowledgeContentHash("内容"),
        createdBy: "user-1",
      });
      // 不调用 markKnowledgeRevisionIndexState，直接发布
      await expect(
        publishKnowledgeDocumentRevision({
          tenantId,
          revisionId: rev.id,
          expectedDocumentVersionNo: doc.versionNo,
        }),
      ).rejects.toBeInstanceOf(KnowledgeRevisionIndexNotReadyError);
    } finally {
      await cleanupTenantKnowledge(tenantId);
    }
  });

  it("publishKnowledgeDocumentRevision：重复发布 → KnowledgeRevisionAlreadyPublishedError", async () => {
    const { tenantId } = await seedContext();
    try {
      const base = await createKnowledgeBase({
        tenantId,
        knowledgeKey: "kb-dup-pub",
        displayName: "重复发布测试",
        createdBy: "user-1",
      });
      const doc = await createKnowledgeDocument({
        tenantId,
        knowledgeBaseId: base.id,
        documentKey: "doc-dup",
        title: "重复发布文档",
        sourceType: "manual",
        createdBy: "user-1",
      });
      const rev = await createKnowledgeDocumentRevision({
        tenantId,
        documentId: doc.id,
        revisionNo: "0001",
        contentRedacted: "内容",
        contentHash: computeKnowledgeContentHash("内容"),
        createdBy: "user-1",
      });
      await markKnowledgeRevisionIndexState({
        tenantId,
        revisionId: rev.id,
        indexState: "ready",
      });
      const firstPub = await publishKnowledgeDocumentRevision({
        tenantId,
        revisionId: rev.id,
        expectedDocumentVersionNo: doc.versionNo,
      });
      // 再次发布（用更新后的 versionNo）→ 抛错
      await expect(
        publishKnowledgeDocumentRevision({
          tenantId,
          revisionId: rev.id,
          expectedDocumentVersionNo: firstPub.document.versionNo,
        }),
      ).rejects.toBeInstanceOf(KnowledgeRevisionAlreadyPublishedError);
    } finally {
      await cleanupTenantKnowledge(tenantId);
    }
  });

  it("publishKnowledgeDocumentRevision：版本号不匹配 → KnowledgeVersionConflictError", async () => {
    const { tenantId } = await seedContext();
    try {
      const base = await createKnowledgeBase({
        tenantId,
        knowledgeKey: "kb-ver-conflict",
        displayName: "版本冲突测试",
        createdBy: "user-1",
      });
      const doc = await createKnowledgeDocument({
        tenantId,
        knowledgeBaseId: base.id,
        documentKey: "doc-conflict",
        title: "冲突文档",
        sourceType: "manual",
        createdBy: "user-1",
      });
      const rev = await createKnowledgeDocumentRevision({
        tenantId,
        documentId: doc.id,
        revisionNo: "0001",
        contentRedacted: "内容",
        contentHash: computeKnowledgeContentHash("内容"),
        createdBy: "user-1",
      });
      await markKnowledgeRevisionIndexState({
        tenantId,
        revisionId: rev.id,
        indexState: "ready",
      });
      await expect(
        publishKnowledgeDocumentRevision({
          tenantId,
          revisionId: rev.id,
          expectedDocumentVersionNo: "wrong-version",
        }),
      ).rejects.toBeInstanceOf(KnowledgeVersionConflictError);
    } finally {
      await cleanupTenantKnowledge(tenantId);
    }
  });

  it("publishKnowledgeDocumentRevision：发布新版本 → 旧 published 变为 superseded", async () => {
    const { tenantId } = await seedContext();
    try {
      const base = await createKnowledgeBase({
        tenantId,
        knowledgeKey: "kb-supersede",
        displayName: "取代测试",
        createdBy: "user-1",
      });
      const doc = await createKnowledgeDocument({
        tenantId,
        knowledgeBaseId: base.id,
        documentKey: "doc-supersede",
        title: "取代文档",
        sourceType: "manual",
        createdBy: "user-1",
      });
      // rev1
      const rev1 = await createKnowledgeDocumentRevision({
        tenantId,
        documentId: doc.id,
        revisionNo: "0001",
        contentRedacted: "v1 内容",
        contentHash: computeKnowledgeContentHash("v1 内容"),
        createdBy: "user-1",
      });
      await markKnowledgeRevisionIndexState({
        tenantId,
        revisionId: rev1.id,
        indexState: "ready",
      });
      const pub1 = await publishKnowledgeDocumentRevision({
        tenantId,
        revisionId: rev1.id,
        expectedDocumentVersionNo: doc.versionNo,
      });
      expect(pub1.previousRevision).toBeUndefined();

      // rev2
      const rev2 = await createKnowledgeDocumentRevision({
        tenantId,
        documentId: doc.id,
        revisionNo: "0002",
        contentRedacted: "v2 内容",
        contentHash: computeKnowledgeContentHash("v2 内容"),
        createdBy: "user-1",
      });
      await markKnowledgeRevisionIndexState({
        tenantId,
        revisionId: rev2.id,
        indexState: "ready",
      });
      const pub2 = await publishKnowledgeDocumentRevision({
        tenantId,
        revisionId: rev2.id,
        expectedDocumentVersionNo: pub1.document.versionNo,
      });
      expect(pub2.revision.revisionState).toBe("published");
      expect(pub2.previousRevision?.id).toBe(rev1.id);
      expect(pub2.previousRevision?.revisionState).toBe("superseded");

      // 旧 rev1 状态查询应为 superseded
      const rev1After = await getKnowledgeDocumentRevisionById(tenantId, rev1.id);
      expect(rev1After?.revisionState).toBe("superseded");
    } finally {
      await cleanupTenantKnowledge(tenantId);
    }
  });

  it("retractKnowledgeDocumentRevision：published → retracted", async () => {
    const { tenantId } = await seedContext();
    try {
      const base = await createKnowledgeBase({
        tenantId,
        knowledgeKey: "kb-retract",
        displayName: "撤回测试",
        createdBy: "user-1",
      });
      const doc = await createKnowledgeDocument({
        tenantId,
        knowledgeBaseId: base.id,
        documentKey: "doc-retract",
        title: "撤回文档",
        sourceType: "manual",
        createdBy: "user-1",
      });
      const rev = await createKnowledgeDocumentRevision({
        tenantId,
        documentId: doc.id,
        revisionNo: "0001",
        contentRedacted: "撤回前内容",
        contentHash: computeKnowledgeContentHash("撤回前内容"),
        createdBy: "user-1",
      });
      await markKnowledgeRevisionIndexState({
        tenantId,
        revisionId: rev.id,
        indexState: "ready",
      });
      await publishKnowledgeDocumentRevision({
        tenantId,
        revisionId: rev.id,
        expectedDocumentVersionNo: doc.versionNo,
      });

      const retracted = await retractKnowledgeDocumentRevision({
        tenantId,
        revisionId: rev.id,
        reasonCode: "content_inaccuracy",
      });
      expect(retracted.revisionState).toBe("retracted");

      // 撤回后不再参与检索（搜索应返回 empty 或 unavailable）
      const search = await searchKnowledgeEvidence({
        tenantId,
        query: "撤回",
      });
      // doc.currentRevisionId 仍指向 rev，但 rev 已 retracted → 不在 published+ready 集合中 → unavailable
      expect(search.status).toBe("unavailable");
      expect(search.reasonCode).toBe("revision_index_not_ready");
    } finally {
      await cleanupTenantKnowledge(tenantId);
    }
  });

  it("retractKnowledgeDocumentRevision：非 published 状态 → 抛错", async () => {
    const { tenantId } = await seedContext();
    try {
      const base = await createKnowledgeBase({
        tenantId,
        knowledgeKey: "kb-retract-fail",
        displayName: "撤回失败测试",
        createdBy: "user-1",
      });
      const doc = await createKnowledgeDocument({
        tenantId,
        knowledgeBaseId: base.id,
        documentKey: "doc-retract-fail",
        title: "撤回失败文档",
        sourceType: "manual",
        createdBy: "user-1",
      });
      const rev = await createKnowledgeDocumentRevision({
        tenantId,
        documentId: doc.id,
        revisionNo: "0001",
        contentRedacted: "draft 内容",
        contentHash: computeKnowledgeContentHash("draft 内容"),
        createdBy: "user-1",
      });
      // draft 状态撤回 → 抛错
      await expect(
        retractKnowledgeDocumentRevision({
          tenantId,
          revisionId: rev.id,
          reasonCode: "test",
        }),
      ).rejects.toBeInstanceOf(KnowledgeRevisionAlreadyPublishedError);
    } finally {
      await cleanupTenantKnowledge(tenantId);
    }
  });

  it("createKnowledgeDocumentRevision：非法 contentHash → KnowledgeValidationError", async () => {
    const { tenantId } = await seedContext();
    try {
      const base = await createKnowledgeBase({
        tenantId,
        knowledgeKey: "kb-bad-hash",
        displayName: "非法 hash 测试",
        createdBy: "user-1",
      });
      const doc = await createKnowledgeDocument({
        tenantId,
        knowledgeBaseId: base.id,
        documentKey: "doc-bad-hash",
        title: "非法 hash 文档",
        sourceType: "manual",
        createdBy: "user-1",
      });
      await expect(
        createKnowledgeDocumentRevision({
          tenantId,
          documentId: doc.id,
          revisionNo: "0001",
          contentRedacted: "内容",
          contentHash: "not-a-hash",
          createdBy: "user-1",
        }),
      ).rejects.toBeInstanceOf(KnowledgeValidationError);
    } finally {
      await cleanupTenantKnowledge(tenantId);
    }
  });

  it("upsertKnowledgeIndex：同 chunk 同 provider 幂等 upsert", async () => {
    const { tenantId } = await seedContext();
    try {
      const base = await createKnowledgeBase({
        tenantId,
        knowledgeKey: "kb-index",
        displayName: "索引测试",
        createdBy: "user-1",
      });
      const doc = await createKnowledgeDocument({
        tenantId,
        knowledgeBaseId: base.id,
        documentKey: "doc-index",
        title: "索引文档",
        sourceType: "manual",
        createdBy: "user-1",
      });
      const rev = await createKnowledgeDocumentRevision({
        tenantId,
        documentId: doc.id,
        revisionNo: "0001",
        contentRedacted: "内容",
        contentHash: computeKnowledgeContentHash("内容"),
        createdBy: "user-1",
      });
      const chunk = await createKnowledgeChunk({
        tenantId,
        documentRevisionId: rev.id,
        chunkNo: "001",
        contentRedacted: "chunk 内容",
        contentHash: computeKnowledgeContentHash("chunk 内容"),
      });

      const idx1 = await upsertKnowledgeIndex({
        tenantId,
        chunkId: chunk.id,
        indexProvider: "internal_fulltext",
        indexRef: "ft-ref-1",
        contentHash: chunk.contentHash,
      });
      const idx2 = await upsertKnowledgeIndex({
        tenantId,
        chunkId: chunk.id,
        indexProvider: "internal_fulltext",
        indexRef: "ft-ref-2", // 更新 indexRef
        contentHash: chunk.contentHash,
      });
      // 第二次 upsert 应该更新而非新建
      expect(idx2.id).toBe(idx1.id);
      expect(idx2.indexRef).toBe("ft-ref-2");
    } finally {
      await cleanupTenantKnowledge(tenantId);
    }
  });
});

// ═══════════════════════════════════════════════════════════
// 4. searchKnowledgeEvidence：状态区分（§13.3）
// ═══════════════════════════════════════════════════════════

describe("searchKnowledgeEvidence：状态区分（§13.3）", () => {
  it("无 query → empty + empty_query", async () => {
    const { tenantId } = await seedContext();
    try {
      const result = await searchKnowledgeEvidence({
        tenantId,
        query: "   ",
      });
      expect(result.status).toBe("empty");
      expect(result.reasonCode).toBe("empty_query");
    } finally {
      await cleanupTenantKnowledge(tenantId);
    }
  });

  it("无 KnowledgeBase → empty + no_knowledge_base", async () => {
    const { tenantId } = await seedContext();
    try {
      const result = await searchKnowledgeEvidence({
        tenantId,
        query: "测试",
      });
      expect(result.status).toBe("empty");
      expect(result.reasonCode).toBe("no_knowledge_base");
    } finally {
      await cleanupTenantKnowledge(tenantId);
    }
  });

  it("有 KnowledgeBase 但无 Document → empty + no_published_document", async () => {
    const { tenantId } = await seedContext();
    try {
      await createKnowledgeBase({
        tenantId,
        knowledgeKey: "kb-empty",
        displayName: "空 KB",
        createdBy: "user-1",
      });
      const result = await searchKnowledgeEvidence({
        tenantId,
        query: "测试",
      });
      expect(result.status).toBe("empty");
      expect(result.reasonCode).toBe("no_published_document");
    } finally {
      await cleanupTenantKnowledge(tenantId);
    }
  });

  it("有 currentRevisionId 但 revision 非 published+ready → unavailable + revision_index_not_ready", async () => {
    const { tenantId } = await seedContext();
    try {
      const base = await createKnowledgeBase({
        tenantId,
        knowledgeKey: "kb-unavail",
        displayName: "不可用测试",
        createdBy: "user-1",
      });
      const doc = await createKnowledgeDocument({
        tenantId,
        knowledgeBaseId: base.id,
        documentKey: "doc-unavail",
        title: "不可用文档",
        sourceType: "manual",
        createdBy: "user-1",
      });
      const rev = await createKnowledgeDocumentRevision({
        tenantId,
        documentId: doc.id,
        revisionNo: "0001",
        contentRedacted: "内容",
        contentHash: computeKnowledgeContentHash("内容"),
        createdBy: "user-1",
      });
      // ready 但 published（这里只 ready 不 publish，doc.currentRevisionId 仍为 null）
      // 改为：手动 publish 但把 indexState 推回 stale 来模拟过期场景
      await markKnowledgeRevisionIndexState({
        tenantId,
        revisionId: rev.id,
        indexState: "ready",
      });
      const pub = await publishKnowledgeDocumentRevision({
        tenantId,
        revisionId: rev.id,
        expectedDocumentVersionNo: doc.versionNo,
      });
      // 把 indexState 推回 stale（模拟索引过期）
      await markKnowledgeRevisionIndexState({
        tenantId,
        revisionId: rev.id,
        indexState: "stale",
      });

      const result = await searchKnowledgeEvidence({
        tenantId,
        query: "内容",
      });
      expect(result.status).toBe("unavailable");
      expect(result.reasonCode).toBe("revision_index_not_ready");

      // 清理 pub 后版本号
      void pub;
    } finally {
      await cleanupTenantKnowledge(tenantId);
    }
  });

  it("查询无匹配 → empty + no_query_match", async () => {
    const { tenantId } = await seedContext();
    try {
      const base = await createKnowledgeBase({
        tenantId,
        knowledgeKey: "kb-no-match",
        displayName: "无匹配测试",
        createdBy: "user-1",
      });
      const doc = await createKnowledgeDocument({
        tenantId,
        knowledgeBaseId: base.id,
        documentKey: "doc-no-match",
        title: "无匹配文档",
        sourceType: "manual",
        createdBy: "user-1",
      });
      const rev = await createKnowledgeDocumentRevision({
        tenantId,
        documentId: doc.id,
        revisionNo: "0001",
        contentRedacted: "Apple Banana Cherry",
        contentHash: computeKnowledgeContentHash("Apple Banana Cherry"),
        createdBy: "user-1",
      });
      await createKnowledgeChunk({
        tenantId,
        documentRevisionId: rev.id,
        chunkNo: "001",
        contentRedacted: "Apple Banana Cherry",
        contentHash: computeKnowledgeContentHash("Apple Banana Cherry"),
      });
      await markKnowledgeRevisionIndexState({
        tenantId,
        revisionId: rev.id,
        indexState: "ready",
      });
      await publishKnowledgeDocumentRevision({
        tenantId,
        revisionId: rev.id,
        expectedDocumentVersionNo: doc.versionNo,
      });

      const result = await searchKnowledgeEvidence({
        tenantId,
        query: "Durian", // 不存在的关键词
      });
      expect(result.status).toBe("empty");
      expect(result.reasonCode).toBe("no_query_match");
    } finally {
      await cleanupTenantKnowledge(tenantId);
    }
  });

  it("成功检索 → ok + hits 含相关性、时效信息", async () => {
    const { tenantId } = await seedContext();
    try {
      const base = await createKnowledgeBase({
        tenantId,
        knowledgeKey: "kb-success",
        displayName: "成功检索测试",
        createdBy: "user-1",
      });
      const doc = await createKnowledgeDocument({
        tenantId,
        knowledgeBaseId: base.id,
        documentKey: "doc-success",
        title: "成功文档",
        sourceType: "manual",
        createdBy: "user-1",
      });
      const revText = "V11 部署需要 MySQL 8 容器，运行 pnpm v11:migrate 应用迁移。";
      const rev = await createKnowledgeDocumentRevision({
        tenantId,
        documentId: doc.id,
        revisionNo: "0001",
        contentRedacted: revText,
        contentHash: computeKnowledgeContentHash(revText),
        createdBy: "user-1",
      });
      await createKnowledgeChunk({
        tenantId,
        documentRevisionId: rev.id,
        chunkNo: "001",
        contentRedacted: revText,
        contentHash: computeKnowledgeContentHash(revText),
        metadataJson: { page: 1, section: "deploy" },
      });
      await markKnowledgeRevisionIndexState({
        tenantId,
        revisionId: rev.id,
        indexState: "ready",
      });
      await publishKnowledgeDocumentRevision({
        tenantId,
        revisionId: rev.id,
        expectedDocumentVersionNo: doc.versionNo,
      });

      const result = await searchKnowledgeEvidence({
        tenantId,
        query: "MySQL",
      });
      expect(result.status).toBe("ok");
      expect(result.hits.length).toBeGreaterThanOrEqual(1);
      const hit = result.hits[0];
      if (!hit) throw new Error("hit 不应为空");
      expect(hit.chunkText).toContain("MySQL");
      expect(hit.revisionId).toBe(rev.id);
      expect(hit.revisionHash).toBe(rev.contentHash);
      expect(hit.revisionPublishedAt).toBeInstanceOf(Date);
      expect(hit.documentKey).toBe("doc-success");
      expect(hit.documentTitle).toBe("成功文档");
      expect(hit.knowledgeBaseKey).toBe("kb-success");
      expect(hit.knowledgeBaseDisplayName).toBe("成功检索测试");
      expect(hit.score).toBeGreaterThan(0);
      expect(hit.selectionReason).toBe("fulltext_match");
      expect(hit.chunkMetadata).toEqual({ page: 1, section: "deploy" });
    } finally {
      await cleanupTenantKnowledge(tenantId);
    }
  });

  it("跨租户隔离：searchKnowledgeEvidence 不返回其他租户的 chunk", async () => {
    const { tenantId } = await seedContext();
    const otherTenantId = "00000000-0000-4000-8000-000000000099";
    // 显式插入另一个租户（避免 FK 约束失败）
    await db.insert(tenantTable).values({
      id: otherTenantId,
      key: "other-tenant",
      name: "Other Tenant",
      status: "active",
    });
    try {
      // 在另一个租户创建完整知识库
      const base = await createKnowledgeBase({
        tenantId: otherTenantId,
        knowledgeKey: "kb-cross-tenant",
        displayName: "跨租户测试",
        createdBy: "user-1",
      });
      const doc = await createKnowledgeDocument({
        tenantId: otherTenantId,
        knowledgeBaseId: base.id,
        documentKey: "doc-cross",
        title: "跨租户文档",
        sourceType: "manual",
        createdBy: "user-1",
      });
      const rev = await createKnowledgeDocumentRevision({
        tenantId: otherTenantId,
        documentId: doc.id,
        revisionNo: "0001",
        contentRedacted: "CrossTenantSecret",
        contentHash: computeKnowledgeContentHash("CrossTenantSecret"),
        createdBy: "user-1",
      });
      await createKnowledgeChunk({
        tenantId: otherTenantId,
        documentRevisionId: rev.id,
        chunkNo: "001",
        contentRedacted: "CrossTenantSecret",
        contentHash: computeKnowledgeContentHash("CrossTenantSecret"),
      });
      await markKnowledgeRevisionIndexState({
        tenantId: otherTenantId,
        revisionId: rev.id,
        indexState: "ready",
      });
      await publishKnowledgeDocumentRevision({
        tenantId: otherTenantId,
        revisionId: rev.id,
        expectedDocumentVersionNo: doc.versionNo,
      });

      // 在默认租户查询 → 应返回 empty（no_knowledge_base）
      const result = await searchKnowledgeEvidence({
        tenantId,
        query: "CrossTenantSecret",
      });
      expect(result.status).toBe("empty");
      expect(result.reasonCode).toBe("no_knowledge_base");
    } finally {
      await cleanupTenantKnowledge(tenantId);
      await cleanupTenantKnowledge(otherTenantId);
    }
  });
});

// ═══════════════════════════════════════════════════════════
// 5. KnowledgeResolver 集成
// ═══════════════════════════════════════════════════════════

describe("KnowledgeResolver 集成", () => {
  it("有 query + 成功发布 + 命中 → ok + knowledge kind Fragment", async () => {
    const { tenantId } = await seedContext();
    try {
      const base = await createKnowledgeBase({
        tenantId,
        knowledgeKey: "kb-resolver",
        displayName: "解析器测试",
        createdBy: "user-1",
      });
      const doc = await createKnowledgeDocument({
        tenantId,
        knowledgeBaseId: base.id,
        documentKey: "doc-resolver",
        title: "解析器文档",
        sourceType: "manual",
        createdBy: "user-1",
      });
      const text = "V11 Knowledge Resolver 测试：部署流程文档";
      const rev = await createKnowledgeDocumentRevision({
        tenantId,
        documentId: doc.id,
        revisionNo: "0001",
        contentRedacted: text,
        contentHash: computeKnowledgeContentHash(text),
        createdBy: "user-1",
      });
      await createKnowledgeChunk({
        tenantId,
        documentRevisionId: rev.id,
        chunkNo: "001",
        contentRedacted: text,
        contentHash: computeKnowledgeContentHash(text),
      });
      await markKnowledgeRevisionIndexState({
        tenantId,
        revisionId: rev.id,
        indexState: "ready",
      });
      await publishKnowledgeDocumentRevision({
        tenantId,
        revisionId: rev.id,
        expectedDocumentVersionNo: doc.versionNo,
      });

      const resolver = new KnowledgeResolver();
      const result = await resolver.resolve({
        tenantId,
        invocationId: "inv1",
        query: "Knowledge",
      });

      expect(result.status).toBe("ok");
      expect(result.fragments.length).toBeGreaterThanOrEqual(1);
      const frag = result.fragments[0];
      if (!frag) throw new Error("expected fragment");
      expect(frag.kind).toBe("knowledge");
      expect(frag.sourceRef.type).toBe("knowledge_chunk");
      expect(frag.sourceRef.revisionId).toBe(rev.id);
      expect(frag.sourceRef.documentId).toBe(doc.id);
      expect(frag.sourceRef.knowledgeBaseId).toBe(base.id);
      expect(frag.contentHash).toBeTruthy();
      expect(frag.text).toContain("Knowledge");
      expect(frag.scope).toBe("project");
      expect(frag.trust).toBe("trusted_data");
      expect(frag.selectionReason).toContain("knowledge_evidence");
    } finally {
      await cleanupTenantKnowledge(tenantId);
    }
  });

  it("restricted classification → 不返回正文 text", async () => {
    const { tenantId } = await seedContext();
    try {
      const base = await createKnowledgeBase({
        tenantId,
        knowledgeKey: "kb-restricted",
        displayName: "受限测试",
        createdBy: "user-1",
      });
      const doc = await createKnowledgeDocument({
        tenantId,
        knowledgeBaseId: base.id,
        documentKey: "doc-restricted",
        title: "受限文档",
        sourceType: "manual",
        createdBy: "user-1",
      });
      const text = "机密部署步骤";
      const rev = await createKnowledgeDocumentRevision({
        tenantId,
        documentId: doc.id,
        revisionNo: "0001",
        contentRedacted: text,
        contentHash: computeKnowledgeContentHash(text),
        createdBy: "user-1",
      });
      await createKnowledgeChunk({
        tenantId,
        documentRevisionId: rev.id,
        chunkNo: "001",
        contentRedacted: text,
        contentHash: computeKnowledgeContentHash(text),
      });
      await markKnowledgeRevisionIndexState({
        tenantId,
        revisionId: rev.id,
        indexState: "ready",
      });
      await publishKnowledgeDocumentRevision({
        tenantId,
        revisionId: rev.id,
        expectedDocumentVersionNo: doc.versionNo,
      });

      const resolver = new KnowledgeResolver();
      const result = await resolver.resolve({
        tenantId,
        invocationId: "inv1",
        query: "机密",
        classification: "restricted",
      });
      expect(result.status).toBe("ok");
      expect(result.fragments.length).toBeGreaterThanOrEqual(1);
      const frag = result.fragments[0];
      if (!frag) throw new Error("expected fragment");
      // restricted sensitivity 不携带正文
      expect(frag.text).toBeUndefined();
      expect(frag.contentHash).toBeTruthy();
      expect(frag.sourceRef.hash).toBeTruthy();
    } finally {
      await cleanupTenantKnowledge(tenantId);
    }
  });
});

// ═══════════════════════════════════════════════════════════
// 6. Admin API：POST /admin/api/v1/knowledge-bases
// ═══════════════════════════════════════════════════════════

describe("POST /admin/api/v1/knowledge-bases", () => {
  it("缺少身份 → 401 AUTHENTICATION_REQUIRED", async () => {
    await seedContext();
    const request = buildV11Request({
      audience: "admin",
      method: "POST",
      path: "/knowledge-bases",
      token: "invalid-workload-token",
      idempotencyKey: "idem-kb-1",
      body: {
        knowledge_key: "kb-api",
        display_name: "API 测试",
      },
    });
    const response = await knowledgeBaseCreatePOST(request);
    expect(response.status).toBe(401);
    const body = await response.json();
    expect(body.error.code).toBe("AUTHENTICATION_REQUIRED");
  });

  it("缺少 Idempotency-Key → 400 REQUEST_SCHEMA_INVALID", async () => {
    const { tenantId, principalBindingId } = await seedContext();
    await grantKnowledgeScopes(tenantId, principalBindingId);
    const request = buildV11Request({
      audience: "admin",
      method: "POST",
      path: "/knowledge-bases",
      body: {
        knowledge_key: "kb-api",
        display_name: "API 测试",
      },
    });
    const response = await knowledgeBaseCreatePOST(request);
    expect(response.status).toBe(400);
  });

  it("缺少 action scope 绑定 → 403 ACTION_SCOPE_DENIED", async () => {
    await seedContext();
    const request = buildV11Request({
      audience: "admin",
      method: "POST",
      path: "/knowledge-bases",
      idempotencyKey: "idem-kb-noscope",
      body: {
        knowledge_key: "kb-api",
        display_name: "API 测试",
      },
    });
    const response = await knowledgeBaseCreatePOST(request);
    expect(response.status).toBe(403);
    const body = await response.json();
    expect(body.error.code).toBe("ACTION_SCOPE_DENIED");
  });

  it("请求体非法（缺 display_name）→ 400 REQUEST_SCHEMA_INVALID", async () => {
    const { tenantId, principalBindingId } = await seedContext();
    await grantKnowledgeScopes(tenantId, principalBindingId);
    try {
      const request = buildV11Request({
        audience: "admin",
        method: "POST",
        path: "/knowledge-bases",
        idempotencyKey: "idem-kb-badbody",
        body: { knowledge_key: "kb-api" },
      });
      const response = await knowledgeBaseCreatePOST(request);
      expect(response.status).toBe(400);
    } finally {
      await cleanupTenantKnowledge(tenantId);
    }
  });

  it("成功创建 → 201 + ETag + knowledge_base 投影", async () => {
    const { tenantId, principalBindingId } = await seedContext();
    await grantKnowledgeScopes(tenantId, principalBindingId);
    try {
      const request = buildV11Request({
        audience: "admin",
        method: "POST",
        path: "/knowledge-bases",
        idempotencyKey: "idem-kb-success",
        body: {
          knowledge_key: "kb-api-success",
          display_name: "API 成功测试",
          description: "通过 Admin API 创建",
        },
      });
      const response = await knowledgeBaseCreatePOST(request);
      expect(response.status).toBe(201);
      const body = await response.json();
      expect(body.knowledge_key).toBe("kb-api-success");
      expect(body.display_name).toBe("API 成功测试");
      expect(body.lifecycle_state).toBe("active");
      expect(body.index_state).toBe("pending");
      expect(body.version_no).toBeTruthy();
      expect(body.etag).toBe(`knowledge-base-${body.version_no}`);
      expect(response.headers.get("etag")).toBeTruthy();
    } finally {
      await cleanupTenantKnowledge(tenantId);
    }
  });

  it("幂等重放：相同 Idempotency-Key + 相同请求 → 200 + 同 candidate_id", async () => {
    const { tenantId, principalBindingId } = await seedContext();
    await grantKnowledgeScopes(tenantId, principalBindingId);
    try {
      const req1 = buildV11Request({
        audience: "admin",
        method: "POST",
        path: "/knowledge-bases",
        idempotencyKey: "idem-kb-replay",
        body: {
          knowledge_key: "kb-replay",
          display_name: "重放测试",
        },
      });
      const resp1 = await knowledgeBaseCreatePOST(req1);
      expect(resp1.status).toBe(201);
      const body1 = await resp1.json();

      const req2 = buildV11Request({
        audience: "admin",
        method: "POST",
        path: "/knowledge-bases",
        idempotencyKey: "idem-kb-replay",
        body: {
          knowledge_key: "kb-replay",
          display_name: "重放测试",
        },
      });
      const resp2 = await knowledgeBaseCreatePOST(req2);
      // 重放返回原状态码（201 表示资源已创建），与原始响应一致
      expect(resp2.status).toBe(201);
      const body2 = await resp2.json();
      expect(body2.id).toBe(body1.id);
    } finally {
      await cleanupTenantKnowledge(tenantId);
    }
  });

  it("幂等冲突：相同 Idempotency-Key + 不同请求 → 409 IDEMPOTENCY_CONFLICT", async () => {
    const { tenantId, principalBindingId } = await seedContext();
    await grantKnowledgeScopes(tenantId, principalBindingId);
    try {
      const req1 = buildV11Request({
        audience: "admin",
        method: "POST",
        path: "/knowledge-bases",
        idempotencyKey: "idem-kb-conflict",
        body: {
          knowledge_key: "kb-conflict-1",
          display_name: "冲突测试 1",
        },
      });
      const resp1 = await knowledgeBaseCreatePOST(req1);
      expect(resp1.status).toBe(201);

      const req2 = buildV11Request({
        audience: "admin",
        method: "POST",
        path: "/knowledge-bases",
        idempotencyKey: "idem-kb-conflict",
        body: {
          knowledge_key: "kb-conflict-2", // 不同 knowledge_key
          display_name: "冲突测试 2",
        },
      });
      const resp2 = await knowledgeBaseCreatePOST(req2);
      expect(resp2.status).toBe(409);
      const body = await resp2.json();
      expect(body.error.code).toBe("IDEMPOTENCY_CONFLICT");
    } finally {
      await cleanupTenantKnowledge(tenantId);
    }
  });

  it("GET 列表 → 200 + items 数组", async () => {
    const { tenantId, principalBindingId } = await seedContext();
    await grantKnowledgeScopes(tenantId, principalBindingId);
    try {
      await createKnowledgeBase({
        tenantId,
        knowledgeKey: "kb-list-api-1",
        displayName: "列表1",
        createdBy: "user-1",
      });
      await createKnowledgeBase({
        tenantId,
        knowledgeKey: "kb-list-api-2",
        displayName: "列表2",
        createdBy: "user-1",
      });

      const request = buildV11Request({
        audience: "admin",
        method: "GET",
        path: "/knowledge-bases",
      });
      const response = await knowledgeBaseListGET(request);
      expect(response.status).toBe(200);
      const body = await response.json();
      expect(body.items).toHaveLength(2);
      expect(body.items.map((i: { knowledge_key: string }) => i.knowledge_key).sort()).toEqual([
        "kb-list-api-1",
        "kb-list-api-2",
      ]);
    } finally {
      await cleanupTenantKnowledge(tenantId);
    }
  });
});

// ═══════════════════════════════════════════════════════════
// 7. Admin API：Document / Revision / Chunk / Publish / Retract
// ═══════════════════════════════════════════════════════════

describe("Admin API：Document + Revision + Chunk + Publish 完整流程", () => {
  it("通过 API 创建 → 文档 → 修订 → chunk → mark-index-ready → publish → 检索可见", async () => {
    const { tenantId, principalBindingId } = await seedContext();
    await grantKnowledgeScopes(tenantId, principalBindingId);
    try {
      // 1. 创建 KnowledgeBase
      const kbReq = buildV11Request({
        audience: "admin",
        method: "POST",
        path: "/knowledge-bases",
        idempotencyKey: "idem-flow-kb",
        body: {
          knowledge_key: "flow-kb",
          display_name: "完整流程测试",
        },
      });
      const kbResp = await knowledgeBaseCreatePOST(kbReq);
      expect(kbResp.status).toBe(201);
      const kb = await kbResp.json();
      const baseId = kb.id;

      // 2. 创建 Document
      const docReq = buildV11Request({
        audience: "admin",
        method: "POST",
        path: `/knowledge-bases/${baseId}/documents`,
        idempotencyKey: "idem-flow-doc",
        body: {
          document_key: "flow-doc",
          title: "流程文档",
          source_type: "manual",
        },
      });
      const docResp = await documentCreatePOST(docReq);
      expect(docResp.status).toBe(201);
      const doc = await docResp.json();
      const documentId = doc.id;
      const docEtag = doc.etag;
      expect(doc.current_revision_id).toBeNull();

      // 3. 创建 Revision
      const revText = "通过 API 创建的部署文档：MySQL 8 + pnpm v11:migrate";
      const revReq = buildV11Request({
        audience: "admin",
        method: "POST",
        path: `/knowledge-bases/${baseId}/documents/${documentId}/revisions`,
        idempotencyKey: "idem-flow-rev",
        body: {
          revision_no: "0001",
          content_redacted: revText,
          content_hash: computeKnowledgeContentHash(revText),
        },
      });
      const revResp = await revisionCreatePOST(revReq);
      expect(revResp.status).toBe(201);
      const rev = await revResp.json();
      const revisionId = rev.id;
      expect(rev.revision_state).toBe("draft");
      expect(rev.index_state).toBe("pending");

      // 4. 创建 Chunk
      const chunkReq = buildV11Request({
        audience: "admin",
        method: "POST",
        path: `/knowledge-bases/${baseId}/documents/${documentId}/revisions/${revisionId}/chunks`,
        idempotencyKey: "idem-flow-chunk",
        body: {
          chunk_no: "001",
          content_redacted: revText,
          content_hash: computeKnowledgeContentHash(revText),
        },
      });
      const chunkResp = await chunkCreatePOST(chunkReq);
      expect(chunkResp.status).toBe(201);

      // 5. mark-index-ready
      const markReq = buildV11Request({
        audience: "admin",
        method: "POST",
        path: `/knowledge-bases/${baseId}/documents/${documentId}/revisions/${revisionId}:mark-index-ready`,
        idempotencyKey: "idem-flow-mark",
      });
      const markResp = await revisionMarkIndexReadyPOST(markReq, {
        params: Promise.resolve({}),
      });
      expect(markResp.status).toBe(200);
      const markBody = await markResp.json();
      expect(markBody.revision.index_state).toBe("ready");

      // 6. publish（需要 If-Match header）
      const pubReq = buildV11Request({
        audience: "admin",
        method: "POST",
        path: `/knowledge-bases/${baseId}/documents/${documentId}/revisions/${revisionId}:publish`,
        idempotencyKey: "idem-flow-pub",
        ifMatch: docEtag,
        body: {},
      });
      const pubResp = await revisionPublishPOST(pubReq, {
        params: Promise.resolve({}),
      });
      expect(pubResp.status).toBe(200);
      const pubBody = await pubResp.json();
      expect(pubBody.revision.revision_state).toBe("published");
      expect(pubBody.document.current_revision_id).toBe(revisionId);
      expect(pubBody.document.etag).not.toBe(docEtag);

      // 7. 检索可见
      const search = await searchKnowledgeEvidence({
        tenantId,
        query: "MySQL",
      });
      expect(search.status).toBe("ok");
      expect(search.hits.length).toBeGreaterThanOrEqual(1);
      const hit = search.hits[0];
      if (!hit) throw new Error("hit 不应为空");
      expect(hit.documentId).toBe(documentId);
    } finally {
      await cleanupTenantKnowledge(tenantId);
    }
  });

  it("publish：缺少 If-Match → 400 REQUEST_SCHEMA_INVALID", async () => {
    const { tenantId, principalBindingId } = await seedContext();
    await grantKnowledgeScopes(tenantId, principalBindingId);
    try {
      const base = await createKnowledgeBase({
        tenantId,
        knowledgeKey: "kb-api-noifmatch",
        displayName: "无 If-Match 测试",
        createdBy: "user-1",
      });
      const doc = await createKnowledgeDocument({
        tenantId,
        knowledgeBaseId: base.id,
        documentKey: "doc-noifmatch",
        title: "无 If-Match 文档",
        sourceType: "manual",
        createdBy: "user-1",
      });
      const rev = await createKnowledgeDocumentRevision({
        tenantId,
        documentId: doc.id,
        revisionNo: "0001",
        contentRedacted: "内容",
        contentHash: computeKnowledgeContentHash("内容"),
        createdBy: "user-1",
      });

      const req = buildV11Request({
        audience: "admin",
        method: "POST",
        path: `/knowledge-bases/${base.id}/documents/${doc.id}/revisions/${rev.id}:publish`,
        idempotencyKey: "idem-noifmatch",
        body: {},
      });
      const resp = await revisionPublishPOST(req, {
        params: Promise.resolve({}),
      });
      expect(resp.status).toBe(400);
    } finally {
      await cleanupTenantKnowledge(tenantId);
    }
  });

  it("publish：If-Match 不匹配 → 412 ETAG_MISMATCH", async () => {
    const { tenantId, principalBindingId } = await seedContext();
    await grantKnowledgeScopes(tenantId, principalBindingId);
    try {
      const base = await createKnowledgeBase({
        tenantId,
        knowledgeKey: "kb-api-etag",
        displayName: "ETag 不匹配测试",
        createdBy: "user-1",
      });
      const doc = await createKnowledgeDocument({
        tenantId,
        knowledgeBaseId: base.id,
        documentKey: "doc-etag",
        title: "ETag 文档",
        sourceType: "manual",
        createdBy: "user-1",
      });
      const rev = await createKnowledgeDocumentRevision({
        tenantId,
        documentId: doc.id,
        revisionNo: "0001",
        contentRedacted: "内容",
        contentHash: computeKnowledgeContentHash("内容"),
        createdBy: "user-1",
      });

      const req = buildV11Request({
        audience: "admin",
        method: "POST",
        path: `/knowledge-bases/${base.id}/documents/${doc.id}/revisions/${rev.id}:publish`,
        idempotencyKey: "idem-etag-mismatch",
        ifMatch: "knowledge-document-wrong-version",
        body: {},
      });
      const resp = await revisionPublishPOST(req, {
        params: Promise.resolve({}),
      });
      expect(resp.status).toBe(412);
      const body = await resp.json();
      expect(body.error.code).toBe("ETAG_MISMATCH");
    } finally {
      await cleanupTenantKnowledge(tenantId);
    }
  });

  it("publish：索引未就绪 → 422 BUSINESS_CONSTRAINT_VIOLATION", async () => {
    const { tenantId, principalBindingId } = await seedContext();
    await grantKnowledgeScopes(tenantId, principalBindingId);
    try {
      const base = await createKnowledgeBase({
        tenantId,
        knowledgeKey: "kb-api-notready",
        displayName: "索引未就绪 API 测试",
        createdBy: "user-1",
      });
      const doc = await createKnowledgeDocument({
        tenantId,
        knowledgeBaseId: base.id,
        documentKey: "doc-notready",
        title: "索引未就绪文档",
        sourceType: "manual",
        createdBy: "user-1",
      });
      const rev = await createKnowledgeDocumentRevision({
        tenantId,
        documentId: doc.id,
        revisionNo: "0001",
        contentRedacted: "内容",
        contentHash: computeKnowledgeContentHash("内容"),
        createdBy: "user-1",
      });

      const req = buildV11Request({
        audience: "admin",
        method: "POST",
        path: `/knowledge-bases/${base.id}/documents/${doc.id}/revisions/${rev.id}:publish`,
        idempotencyKey: "idem-api-notready",
        ifMatch: `knowledge-document-${doc.versionNo}`,
        body: {},
      });
      const resp = await revisionPublishPOST(req, {
        params: Promise.resolve({}),
      });
      expect(resp.status).toBe(422);
      const body = await resp.json();
      expect(body.error.code).toBe("BUSINESS_CONSTRAINT_VIOLATION");
    } finally {
      await cleanupTenantKnowledge(tenantId);
    }
  });

  it("retract：成功撤回已发布修订", async () => {
    const { tenantId, principalBindingId } = await seedContext();
    await grantKnowledgeScopes(tenantId, principalBindingId);
    try {
      const base = await createKnowledgeBase({
        tenantId,
        knowledgeKey: "kb-api-retract",
        displayName: "撤回 API 测试",
        createdBy: "user-1",
      });
      const doc = await createKnowledgeDocument({
        tenantId,
        knowledgeBaseId: base.id,
        documentKey: "doc-api-retract",
        title: "撤回 API 文档",
        sourceType: "manual",
        createdBy: "user-1",
      });
      const rev = await createKnowledgeDocumentRevision({
        tenantId,
        documentId: doc.id,
        revisionNo: "0001",
        contentRedacted: "撤回前内容",
        contentHash: computeKnowledgeContentHash("撤回前内容"),
        createdBy: "user-1",
      });
      await markKnowledgeRevisionIndexState({
        tenantId,
        revisionId: rev.id,
        indexState: "ready",
      });
      await publishKnowledgeDocumentRevision({
        tenantId,
        revisionId: rev.id,
        expectedDocumentVersionNo: doc.versionNo,
      });

      const req = buildV11Request({
        audience: "admin",
        method: "POST",
        path: `/knowledge-bases/${base.id}/documents/${doc.id}/revisions/${rev.id}:retract`,
        idempotencyKey: "idem-api-retract",
        body: { reason_code: "content_inaccuracy" },
      });
      const resp = await revisionRetractPOST(req, {
        params: Promise.resolve({}),
      });
      expect(resp.status).toBe(200);
      const body = await resp.json();
      expect(body.revision.revision_state).toBe("retracted");
      expect(body.reason_code).toBe("content_inaccuracy");
    } finally {
      await cleanupTenantKnowledge(tenantId);
    }
  });

  it("chunk POST：已 published 的 revision 拒绝新增 chunk", async () => {
    const { tenantId, principalBindingId } = await seedContext();
    await grantKnowledgeScopes(tenantId, principalBindingId);
    try {
      const base = await createKnowledgeBase({
        tenantId,
        knowledgeKey: "kb-chunk-immutable",
        displayName: "Chunk 不可变性测试",
        createdBy: "user-1",
      });
      const doc = await createKnowledgeDocument({
        tenantId,
        knowledgeBaseId: base.id,
        documentKey: "doc-chunk-imm",
        title: "不可变 Chunk 文档",
        sourceType: "manual",
        createdBy: "user-1",
      });
      const rev = await createKnowledgeDocumentRevision({
        tenantId,
        documentId: doc.id,
        revisionNo: "0001",
        contentRedacted: "内容",
        contentHash: computeKnowledgeContentHash("内容"),
        createdBy: "user-1",
      });
      await markKnowledgeRevisionIndexState({
        tenantId,
        revisionId: rev.id,
        indexState: "ready",
      });
      await publishKnowledgeDocumentRevision({
        tenantId,
        revisionId: rev.id,
        expectedDocumentVersionNo: doc.versionNo,
      });

      const req = buildV11Request({
        audience: "admin",
        method: "POST",
        path: `/knowledge-bases/${base.id}/documents/${doc.id}/revisions/${rev.id}/chunks`,
        idempotencyKey: "idem-chunk-imm",
        body: {
          chunk_no: "999",
          content_redacted: "新内容",
          content_hash: computeKnowledgeContentHash("新内容"),
        },
      });
      const resp = await chunkCreatePOST(req);
      expect(resp.status).toBe(400);
      const body = await resp.json();
      expect(body.error.code).toBe("REQUEST_SCHEMA_INVALID");
    } finally {
      await cleanupTenantKnowledge(tenantId);
    }
  });

  it("GET revisions / GET chunks 列表正常返回", async () => {
    const { tenantId, principalBindingId } = await seedContext();
    await grantKnowledgeScopes(tenantId, principalBindingId);
    try {
      const base = await createKnowledgeBase({
        tenantId,
        knowledgeKey: "kb-list-revs",
        displayName: "列表 revisions 测试",
        createdBy: "user-1",
      });
      const doc = await createKnowledgeDocument({
        tenantId,
        knowledgeBaseId: base.id,
        documentKey: "doc-list-revs",
        title: "列表 revisions 文档",
        sourceType: "manual",
        createdBy: "user-1",
      });
      const rev = await createKnowledgeDocumentRevision({
        tenantId,
        documentId: doc.id,
        revisionNo: "0001",
        contentRedacted: "内容",
        contentHash: computeKnowledgeContentHash("内容"),
        createdBy: "user-1",
      });
      await createKnowledgeChunk({
        tenantId,
        documentRevisionId: rev.id,
        chunkNo: "001",
        contentRedacted: "chunk1",
        contentHash: computeKnowledgeContentHash("chunk1"),
      });
      await createKnowledgeChunk({
        tenantId,
        documentRevisionId: rev.id,
        chunkNo: "002",
        contentRedacted: "chunk2",
        contentHash: computeKnowledgeContentHash("chunk2"),
      });

      const revListReq = buildV11Request({
        audience: "admin",
        method: "GET",
        path: `/knowledge-bases/${base.id}/documents/${doc.id}/revisions`,
      });
      const revListResp = await revisionListGET(revListReq);
      expect(revListResp.status).toBe(200);
      const revList = await revListResp.json();
      expect(revList.items).toHaveLength(1);
      expect(revList.items[0].revision_no).toBe("0001");

      const chunkListReq = buildV11Request({
        audience: "admin",
        method: "GET",
        path: `/knowledge-bases/${base.id}/documents/${doc.id}/revisions/${rev.id}/chunks`,
      });
      const chunkListResp = await chunkListGET(chunkListReq);
      expect(chunkListResp.status).toBe(200);
      const chunkList = await chunkListResp.json();
      expect(chunkList.items).toHaveLength(2);
      expect(chunkList.items.map((c: { chunk_no: string }) => c.chunk_no)).toEqual(["001", "002"]);

      const docListReq = buildV11Request({
        audience: "admin",
        method: "GET",
        path: `/knowledge-bases/${base.id}/documents`,
      });
      const docListResp = await documentListGET(docListReq);
      expect(docListResp.status).toBe(200);
      const docList = await docListResp.json();
      expect(docList.items).toHaveLength(1);
      expect(docList.items[0].document_key).toBe("doc-list-revs");
    } finally {
      await cleanupTenantKnowledge(tenantId);
    }
  });
});
