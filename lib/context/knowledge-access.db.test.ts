import {
  computeKnowledgeContentHash,
  createKnowledgeBase,
  createKnowledgeChunk,
  createKnowledgeDocument,
  createKnowledgeDocumentRevision,
  listDiscoverableKnowledgeBases,
  markKnowledgeRevisionIndexState,
  publishKnowledgeDocumentRevision,
  searchKnowledgeEvidence,
} from "@/lib/context/knowledge-queries";
import { KnowledgeResolver } from "@/lib/context/source-resolvers";
import { computeCanonicalDigest } from "@/lib/crypto/rfc-8785-canonicalize";
import { db } from "@/lib/db/client";
import { resetDatabase } from "@/lib/db/test/mysql-harness";
import { ensureDefaultTenant } from "@/lib/identity/tenant-queries";
import type { CapabilityCatalogSnapshot } from "@/lib/runtime/harness-loop/capability-catalog";
import { createPlatformHarnessActionExecutors } from "@/lib/runtime/harness-loop/platform-action-executors";
import { beforeEach, describe, expect, it } from "vitest";

beforeEach(async () => {
  await resetDatabase(db);
});

function acl(users: string[] = [], services: string[] = []) {
  return {
    version: "1",
    grants: {
      users,
      services,
      roles: [],
      scopes: [],
    },
  };
}

async function seedPublishedKnowledge(params: {
  tenantId: string;
  aclSnapshotJson: Record<string, unknown>;
  aclSnapshotHash?: string;
  content?: string;
}) {
  const content = params.content ?? "员工年假余额为十天";
  const base = await createKnowledgeBase({
    tenantId: params.tenantId,
    knowledgeKey: `kb-${crypto.randomUUID()}`,
    displayName: "员工制度",
    createdBy: "test",
  });
  const document = await createKnowledgeDocument({
    tenantId: params.tenantId,
    knowledgeBaseId: base.id,
    documentKey: `doc-${crypto.randomUUID()}`,
    title: "秘密人事制度",
    sourceType: "upload",
    createdBy: "test",
  });
  const revision = await createKnowledgeDocumentRevision({
    tenantId: params.tenantId,
    documentId: document.id,
    revisionNo: "0001",
    contentRedacted: content,
    contentHash: computeKnowledgeContentHash(content),
    aclSnapshotJson: params.aclSnapshotJson,
    aclSnapshotHash: params.aclSnapshotHash ?? computeCanonicalDigest(params.aclSnapshotJson),
    createdBy: "test",
  });
  await createKnowledgeChunk({
    tenantId: params.tenantId,
    documentRevisionId: revision.id,
    chunkNo: "0001",
    contentRedacted: content,
    contentHash: computeKnowledgeContentHash(content),
  });
  await markKnowledgeRevisionIndexState({
    tenantId: params.tenantId,
    revisionId: revision.id,
    indexState: "ready",
  });
  await publishKnowledgeDocumentRevision({
    tenantId: params.tenantId,
    revisionId: revision.id,
    expectedDocumentVersionNo: document.versionNo,
  });
  return { base, document, revision };
}

describe("Knowledge Revision ACL", () => {
  it("same tenant 只返回对 Trusted Subject 授权的 Revision", async () => {
    const tenant = await ensureDefaultTenant();
    const allowed = await seedPublishedKnowledge({
      tenantId: tenant.id,
      aclSnapshotJson: acl(["user-a"]),
    });

    const resultA = await searchKnowledgeEvidence({
      tenantId: tenant.id,
      executionSubject: { tenantId: tenant.id, subjectType: "user", subjectId: "user-a" },
      allowedKnowledgeBaseIds: [allowed.base.id],
      query: "年假",
    });
    expect(resultA.status).toBe("ok");
    expect(resultA.hits).toHaveLength(1);

    const resultB = await searchKnowledgeEvidence({
      tenantId: tenant.id,
      executionSubject: { tenantId: tenant.id, subjectType: "user", subjectId: "user-b" },
      allowedKnowledgeBaseIds: [allowed.base.id],
      query: "年假",
    });
    expect(resultB).toMatchObject({ status: "denied", hits: [] });
    expect(JSON.stringify(resultB)).not.toContain("秘密人事制度");

    const resolverResult = await new KnowledgeResolver().resolve({
      tenantId: tenant.id,
      invocationId: "inv-denied",
      executionSubject: { tenantId: tenant.id, subjectType: "user", subjectId: "user-b" },
      allowedKnowledgeBaseIds: [allowed.base.id],
      query: "年假",
    });
    expect(resolverResult).toMatchObject({ status: "denied", fragments: [] });
  });

  it("service subject 按冻结 ACL allow/deny，跨租户主体 fail closed", async () => {
    const tenant = await ensureDefaultTenant();
    const seeded = await seedPublishedKnowledge({
      tenantId: tenant.id,
      aclSnapshotJson: acl([], ["service-a"]),
    });
    await expect(
      searchKnowledgeEvidence({
        tenantId: tenant.id,
        executionSubject: {
          tenantId: "other-tenant",
          subjectType: "service",
          subjectId: "service-a",
        },
        allowedKnowledgeBaseIds: [seeded.base.id],
        query: "年假",
      }),
    ).resolves.toMatchObject({ status: "denied", hits: [] });
    await expect(
      searchKnowledgeEvidence({
        tenantId: tenant.id,
        executionSubject: { tenantId: tenant.id, subjectType: "service", subjectId: "service-b" },
        allowedKnowledgeBaseIds: [seeded.base.id],
        query: "年假",
      }),
    ).resolves.toMatchObject({ status: "denied", hits: [] });
    await expect(
      searchKnowledgeEvidence({
        tenantId: tenant.id,
        executionSubject: { tenantId: tenant.id, subjectType: "service", subjectId: "service-a" },
        allowedKnowledgeBaseIds: [seeded.base.id],
        query: "年假",
      }),
    ).resolves.toMatchObject({ status: "ok" });
  });

  it("role/scope grant 通过 ACL 快照内的冻结成员关系授权", async () => {
    const tenant = await ensureDefaultTenant();
    const roleGranted = await seedPublishedKnowledge({
      tenantId: tenant.id,
      aclSnapshotJson: {
        version: "1",
        grants: {
          users: [],
          services: [],
          roles: [{ id: "hr-reader", users: ["user-role"], services: [] }],
          scopes: [],
        },
      },
    });
    const scopeGranted = await seedPublishedKnowledge({
      tenantId: tenant.id,
      aclSnapshotJson: {
        version: "1",
        grants: {
          users: [],
          services: [],
          roles: [],
          scopes: [{ id: "org-policy", users: [], services: ["service-scope"] }],
        },
      },
    });
    await expect(
      searchKnowledgeEvidence({
        tenantId: tenant.id,
        executionSubject: { tenantId: tenant.id, subjectType: "user", subjectId: "user-role" },
        allowedKnowledgeBaseIds: [roleGranted.base.id],
        query: "年假",
      }),
    ).resolves.toMatchObject({ status: "ok" });
    await expect(
      searchKnowledgeEvidence({
        tenantId: tenant.id,
        executionSubject: {
          tenantId: tenant.id,
          subjectType: "service",
          subjectId: "service-scope",
        },
        allowedKnowledgeBaseIds: [scopeGranted.base.id],
        query: "年假",
      }),
    ).resolves.toMatchObject({ status: "ok" });
  });

  it("malformed ACL 与 hash mismatch 都不得进入 Chunk 查询", async () => {
    const tenant = await ensureDefaultTenant();
    const malformed = await seedPublishedKnowledge({
      tenantId: tenant.id,
      aclSnapshotJson: { version: "unknown", grants: {} },
    });
    const mismatch = await seedPublishedKnowledge({
      tenantId: tenant.id,
      aclSnapshotJson: acl(["user-a"]),
      aclSnapshotHash: `sha256:${"0".repeat(64)}`,
    });
    for (const baseId of [malformed.base.id, mismatch.base.id]) {
      const result = await searchKnowledgeEvidence({
        tenantId: tenant.id,
        executionSubject: { tenantId: tenant.id, subjectType: "user", subjectId: "user-a" },
        allowedKnowledgeBaseIds: [baseId],
        query: "年假",
      });
      expect(result).toMatchObject({ status: "unavailable", hits: [] });
      expect(JSON.stringify(result)).not.toContain("秘密人事制度");
    }
  });

  it("Hosted 平台 Executor 把 ExecutionBinding Subject 与冻结 Knowledge scope 传入检索", async () => {
    const tenant = await ensureDefaultTenant();
    const seeded = await seedPublishedKnowledge({
      tenantId: tenant.id,
      aclSnapshotJson: acl(["user-a"]),
    });
    const catalog: CapabilityCatalogSnapshot = {
      version: "1",
      invocationId: "inv-1",
      createdAt: new Date().toISOString(),
      sourceRefs: [],
      agents: [],
      tools: [],
      knowledgeSources: [
        {
          sourceRef: `knowledge-base:${seeded.base.id}`,
          knowledgeBaseId: seeded.base.id,
          displayName: seeded.base.displayName,
          description: "",
        },
      ],
      unavailableFacts: [],
    };
    const executors = createPlatformHarnessActionExecutors({
      tenantId: tenant.id,
      executionSubject: { tenantId: tenant.id, subjectType: "user", subjectId: "user-a" },
      capabilityCatalog: catalog,
      resolveRoute: async () => ({
        status: "unresolved",
        reason: "no_eligible_route",
        evaluatedCandidateCount: 0,
      }),
      transportChannel: "hosted",
    });
    const result = await executors["knowledge.search"]!(
      {
        actionType: "knowledge.search",
        actionId: "action-1",
        stepNo: 1,
        purposeCode: "knowledge_lookup",
        shortPurpose: "检索年假制度",
        payload: { query: "年假", maxResults: 5, preferredSourceRefs: [] },
      },
      {
        invocationId: "inv-1",
        tenantId: tenant.id,
        threadId: "thread-1",
        turnId: "turn-1",
        actionDigest: "digest",
      },
    );
    expect(result.observation?.data).toMatchObject({ status: "ok" });
  });

  it("Capability Catalog 可发现性预过滤不暴露未授权 KnowledgeBase", async () => {
    const tenant = await ensureDefaultTenant();
    const allowed = await seedPublishedKnowledge({
      tenantId: tenant.id,
      aclSnapshotJson: acl(["user-a"]),
    });
    await seedPublishedKnowledge({
      tenantId: tenant.id,
      aclSnapshotJson: acl(["user-b"]),
    });
    const discoverable = await listDiscoverableKnowledgeBases({
      tenantId: tenant.id,
      executionSubject: { tenantId: tenant.id, subjectType: "user", subjectId: "user-a" },
    });
    expect(discoverable.map((base) => base.id)).toEqual([allowed.base.id]);
  });
});
