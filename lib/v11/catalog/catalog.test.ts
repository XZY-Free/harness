/**
 * S06-C03：V11 CatalogEntry 投影与员工目录集成测试（真实 MySQL 8 Testcontainers）。
 *
 * 覆盖：
 * - ETag helpers：buildCatalogRevisionEtag / parseCatalogRevisionEtag。
 * - schema 常量：CATALOG_RESOURCE_TYPES / CATALOG_AUDIENCES。
 * - CatalogRevision：getCurrentCatalogRevision / advanceCatalogRevision。
 * - CatalogEntry 投影：refreshCatalogEntry / refreshCatalogByType / removeCatalogEntry。
 * - Catalog 查询：listCatalogOptions / searchCatalog / getCatalogEntryById / getCatalogEntryByResource。
 * - Employee Catalog API：GET /api/v1/catalog/options（身份解析、查询参数、If-None-Match 304 短路径、
 *   ETag 响应、错误映射）。
 *
 * 真实 MySQL 8 Testcontainers，不使用 mock。Employee API 测试需 SNOW_AUTH_MODE=dev。
 */
import { randomUUID } from "node:crypto";
import { GET as catalogOptionsGET } from "@/app/api/v1/catalog/options/route";
import { createAgent } from "@/lib/agents/persistence/agent-queries";
import { DEFAULT_USER_EMAIL, DEFAULT_USER_ID, DEFAULT_USER_NAME } from "@/lib/constants";
import { db } from "@/lib/db/client";
import { buildV11Request } from "@/lib/db/test/api-fixtures";
import { resetDatabase } from "@/lib/db/test/mysql-harness";
import { DEFAULT_TENANT_ID, ensureDefaultTenant } from "@/lib/identity/tenant-queries";
import { upsertUserIdentity } from "@/lib/identity/user-identity-queries";
import { agentTable } from "@/lib/persistence/schema/agent";
import { CATALOG_AUDIENCES, CATALOG_RESOURCE_TYPES } from "@/lib/persistence/schema/catalog";
import { tenant } from "@/lib/persistence/schema/identity";
import { toolProviderTable, toolTable } from "@/lib/persistence/schema/tool";
import { buildCatalogRevisionEtag, parseCatalogRevisionEtag } from "@/lib/v11/admin/route-helpers";
import { createSkill } from "@/lib/v11/capability/skill-queries";
import {
  CatalogQueryError,
  getCatalogEntryById,
  getCatalogEntryByResource,
  listCatalogOptions,
  searchCatalog,
} from "@/lib/v11/catalog/catalog-queries";
import {
  type CatalogEntryInput,
  CatalogProjectionError,
  advanceCatalogRevision,
  getCurrentCatalogRevision,
  refreshCatalogByType,
  refreshCatalogEntry,
  removeCatalogEntry,
} from "@/lib/v11/catalog/projector";
import { eq } from "drizzle-orm";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

// vitest 不加载 .env.test，需手动设置 SNOW_AUTH_MODE=dev（与 employee-api.test.ts 一致）。
const ORIGINAL_AUTH_MODE = process.env.SNOW_AUTH_MODE;

beforeEach(async () => {
  process.env.SNOW_AUTH_MODE = "dev";
  await resetDatabase(db);
});

afterEach(() => {
  process.env.SNOW_AUTH_MODE = ORIGINAL_AUTH_MODE;
});

// ─── 辅助：seed 默认租户 + 用户身份 ────────────────────────

async function seedContext() {
  const t = await ensureDefaultTenant();
  const identity = await upsertUserIdentity({
    tenantId: t.id,
    externalSubject: DEFAULT_USER_ID,
    email: DEFAULT_USER_EMAIL,
    displayName: DEFAULT_USER_NAME,
  });
  return { tenantId: t.id, userIdentityId: identity.id };
}

/** 构造一个 CatalogEntryInput（默认 agent 类型）。 */
function buildEntryInput(
  tenantId: string,
  overrides: Partial<CatalogEntryInput> = {},
): CatalogEntryInput {
  return {
    tenantId,
    resourceType: "agent",
    resourceId: `res-${randomUUID().slice(0, 8)}`,
    displayName: "测试 Agent",
    description: "测试描述",
    ownerUserId: null,
    tagsJson: null,
    lifecycleState: "enabled",
    visibilitySummary: "tenant",
    sourceUpdatedAt: new Date(),
    ...overrides,
  };
}

/** seed 一个 enabled Agent。 */
async function seedAgent(
  tenantId: string,
  ownerId: string,
  agentKey: string,
  displayName?: string,
) {
  return createAgent({
    tenantId,
    agentKey,
    displayName: displayName ?? `Agent ${agentKey}`,
    ownerUserId: ownerId,
    lifecycleState: "enabled",
  });
}

/** seed 一个 Skill。 */
async function seedSkill(
  tenantId: string,
  ownerId: string,
  skillKey: string,
  displayName?: string,
) {
  return createSkill({
    tenantId,
    skillKey,
    displayName: displayName ?? `Skill ${skillKey}`,
    description: `Skill ${skillKey} 描述`,
    ownerUserId: ownerId,
    createdBy: ownerId,
    visibilityScope: "tenant",
  });
}

/** 直接 db.insert seed 一个 enabled ToolProvider + Tool（绕过 createTool 校验，简化测试）。 */
async function seedTool(
  tenantId: string,
  ownerUserId: string,
  toolKey: string,
  displayName?: string,
) {
  const providerId = randomUUID();
  const toolId = randomUUID();
  await db.insert(toolProviderTable).values({
    id: providerId,
    tenantId,
    providerKey: `provider-${toolKey}`,
    providerType: "builtin",
    displayName: `Provider ${toolKey}`,
    ownerUserId,
    lifecycleState: "enabled",
    trustLevel: "standard",
    versionNo: 1,
  });
  await db.insert(toolTable).values({
    id: toolId,
    tenantId,
    providerId,
    toolKey,
    displayName: displayName ?? `Tool ${toolKey}`,
    riskClass: "medium",
    lifecycleState: "enabled",
    versionNo: 1,
  });
  return { providerId, toolId };
}

/** seed 一个额外租户（用于跨租户隔离测试）。 */
async function seedExtraTenant(tenantId: string, key: string) {
  await db.insert(tenant).values({
    id: tenantId,
    key,
    name: `Extra Tenant ${key}`,
    status: "active",
  });
}

// ═══════════════════════════════════════════════════════════
// 1. Catalog ETag helpers
// ═══════════════════════════════════════════════════════════

describe("Catalog ETag helpers", () => {
  it("buildCatalogRevisionEtag 格式为 catalog-{tenantId}-{audience}-{revisionNo}", () => {
    const etag = buildCatalogRevisionEtag("00000000-0000-4000-8000-000000000000", "employee", 7);
    expect(etag).toBe("catalog-00000000-0000-4000-8000-000000000000-employee-7");
  });

  it("parseCatalogRevisionEtag 合法 ETag 返回 revisionNo", () => {
    const etag = buildCatalogRevisionEtag("00000000-0000-4000-8000-000000000000", "runtime", 42);
    expect(parseCatalogRevisionEtag(etag)).toBe(42);
  });

  it("parseCatalogRevisionEtag 非法前缀抛错", () => {
    expect(() => parseCatalogRevisionEtag("route-set-5")).toThrow();
    expect(() => parseCatalogRevisionEtag("catalog_5")).toThrow();
  });

  it("parseCatalogRevisionEtag 非法版本号抛错", () => {
    const badEtag = "catalog-00000000-0000-4000-8000-000000000000-employee-abc";
    expect(() => parseCatalogRevisionEtag(badEtag)).toThrow();
  });

  it("buildCatalogRevisionEtag + parseCatalogRevisionEtag 往返一致", () => {
    for (const revisionNo of [0, 1, 100, 999999]) {
      const etag = buildCatalogRevisionEtag(DEFAULT_TENANT_ID, "employee", revisionNo);
      expect(parseCatalogRevisionEtag(etag)).toBe(revisionNo);
    }
  });
});

// ═══════════════════════════════════════════════════════════
// 2. Catalog schema 常量
// ═══════════════════════════════════════════════════════════

describe("Catalog schema 常量", () => {
  it("CATALOG_RESOURCE_TYPES 包含全部 7 种资源类型", () => {
    expect(CATALOG_RESOURCE_TYPES).toEqual([
      "agent",
      "skill",
      "tool",
      "knowledge",
      "runtime",
      "model",
      "connection",
    ]);
  });

  it("CATALOG_AUDIENCES 包含 employee 与 runtime", () => {
    expect(CATALOG_AUDIENCES).toEqual(["employee", "runtime"]);
  });
});

// ═══════════════════════════════════════════════════════════
// 3. getCurrentCatalogRevision
// ═══════════════════════════════════════════════════════════

describe("getCurrentCatalogRevision", () => {
  it("不存在时返回 0", async () => {
    const { tenantId } = await seedContext();
    const revision = await getCurrentCatalogRevision({
      tenantId,
      audience: "employee",
    });
    expect(revision).toBe(0);
  });

  it("存在时返回当前 revision 值", async () => {
    const { tenantId } = await seedContext();
    await advanceCatalogRevision({ tenantId, audience: "employee" });
    await advanceCatalogRevision({ tenantId, audience: "employee" });
    const revision = await getCurrentCatalogRevision({
      tenantId,
      audience: "employee",
    });
    expect(revision).toBe(2);
  });
});

// ═══════════════════════════════════════════════════════════
// 4. advanceCatalogRevision
// ═══════════════════════════════════════════════════════════

describe("advanceCatalogRevision", () => {
  it("首次推进返回 1（从 0 → 1）", async () => {
    const { tenantId } = await seedContext();
    const newRevision = await advanceCatalogRevision({
      tenantId,
      audience: "employee",
    });
    expect(newRevision).toBe(1);
  });

  it("二次推进返回 2", async () => {
    const { tenantId } = await seedContext();
    await advanceCatalogRevision({ tenantId, audience: "employee" });
    const newRevision = await advanceCatalogRevision({
      tenantId,
      audience: "employee",
    });
    expect(newRevision).toBe(2);
  });

  it("多次推进单调递增", async () => {
    const { tenantId } = await seedContext();
    for (let i = 1; i <= 5; i++) {
      const rev = await advanceCatalogRevision({
        tenantId,
        audience: "employee",
      });
      expect(rev).toBe(i);
    }
  });

  it("不同 audience 独立推进", async () => {
    const { tenantId } = await seedContext();
    const empRev = await advanceCatalogRevision({
      tenantId,
      audience: "employee",
    });
    const rtRev = await advanceCatalogRevision({
      tenantId,
      audience: "runtime",
    });
    expect(empRev).toBe(1);
    expect(rtRev).toBe(1);
    // employee 再推进，runtime 不受影响
    const empRev2 = await advanceCatalogRevision({
      tenantId,
      audience: "employee",
    });
    const rtCurrent = await getCurrentCatalogRevision({
      tenantId,
      audience: "runtime",
    });
    expect(empRev2).toBe(2);
    expect(rtCurrent).toBe(1);
  });

  it("不同租户独立推进", async () => {
    const { tenantId } = await seedContext();
    const extraTenantId = "00000000-0000-4000-8000-000000000099";
    await seedExtraTenant(extraTenantId, "extra");

    const revA = await advanceCatalogRevision({
      tenantId,
      audience: "employee",
    });
    const revB = await advanceCatalogRevision({
      tenantId: extraTenantId,
      audience: "employee",
    });
    expect(revA).toBe(1);
    expect(revB).toBe(1);
  });
});

// ═══════════════════════════════════════════════════════════
// 5. refreshCatalogEntry
// ═══════════════════════════════════════════════════════════

describe("refreshCatalogEntry", () => {
  it("成功创建新行，字段正确写入", async () => {
    const { tenantId } = await seedContext();
    const entry = await refreshCatalogEntry(
      buildEntryInput(tenantId, {
        resourceType: "agent",
        resourceId: "agent-001",
        displayName: "财务 Agent",
        description: "处理财务报表",
        lifecycleState: "enabled",
        visibilitySummary: "tenant",
      }),
    );
    expect(entry.id).toEqual(expect.any(String));
    expect(entry.tenantId).toBe(tenantId);
    expect(entry.resourceType).toBe("agent");
    expect(entry.resourceId).toBe("agent-001");
    expect(entry.displayName).toBe("财务 Agent");
    expect(entry.description).toBe("处理财务报表");
    expect(entry.lifecycleState).toBe("enabled");
    expect(entry.visibilitySummary).toBe("tenant");
    expect(entry.catalogRevision).toBe(1);
  });

  it("upsert 同资源覆盖：相同 (tenantId, resourceType, resourceId) 更新而非新增", async () => {
    const { tenantId } = await seedContext();
    const input = buildEntryInput(tenantId, {
      resourceType: "skill",
      resourceId: "skill-001",
      displayName: "原始名称",
      lifecycleState: "draft",
    });
    const first = await refreshCatalogEntry(input);
    const second = await refreshCatalogEntry({
      ...input,
      displayName: "更新名称",
      lifecycleState: "enabled",
    });
    // id 不变（同一行）
    expect(second.id).toBe(first.id);
    expect(second.displayName).toBe("更新名称");
    expect(second.lifecycleState).toBe("enabled");
    // catalogRevision 推进
    expect(second.catalogRevision).toBe(first.catalogRevision + 1);
  });

  it("投影后 catalogRevision 与 getCurrentCatalogRevision 一致", async () => {
    const { tenantId } = await seedContext();
    await refreshCatalogEntry(buildEntryInput(tenantId));
    const currentRevision = await getCurrentCatalogRevision({
      tenantId,
      audience: "employee",
    });
    expect(currentRevision).toBe(1);
  });

  it("非法 resourceType 抛 CatalogProjectionError", async () => {
    const { tenantId } = await seedContext();
    await expect(
      refreshCatalogEntry(
        buildEntryInput(tenantId, {
          resourceType: "unknown" as never,
        }),
      ),
    ).rejects.toThrow(CatalogProjectionError);
  });

  it("空 displayName 抛 CatalogProjectionError", async () => {
    const { tenantId } = await seedContext();
    await expect(
      refreshCatalogEntry(buildEntryInput(tenantId, { displayName: "" })),
    ).rejects.toThrow(CatalogProjectionError);
  });

  it("空 lifecycleState 抛 CatalogProjectionError", async () => {
    const { tenantId } = await seedContext();
    await expect(
      refreshCatalogEntry(buildEntryInput(tenantId, { lifecycleState: "" })),
    ).rejects.toThrow(CatalogProjectionError);
  });

  it("空 visibilitySummary 抛 CatalogProjectionError", async () => {
    const { tenantId } = await seedContext();
    await expect(
      refreshCatalogEntry(buildEntryInput(tenantId, { visibilitySummary: "" })),
    ).rejects.toThrow(CatalogProjectionError);
  });

  it("不同租户投影互不干扰（UNIQUE 约束按 tenantId 隔离）", async () => {
    const { tenantId } = await seedContext();
    const extraTenantId = "00000000-0000-4000-8000-000000000099";
    await seedExtraTenant(extraTenantId, "extra");

    const entryA = await refreshCatalogEntry(
      buildEntryInput(tenantId, { resourceId: "shared-id" }),
    );
    const entryB = await refreshCatalogEntry(
      buildEntryInput(extraTenantId, { resourceId: "shared-id" }),
    );
    // 同 resourceId 但不同 tenantId → 不同行
    expect(entryA.id).not.toBe(entryB.id);
    expect(entryA.tenantId).toBe(tenantId);
    expect(entryB.tenantId).toBe(extraTenantId);
  });
});

// ═══════════════════════════════════════════════════════════
// 6. refreshCatalogByType
// ═══════════════════════════════════════════════════════════

describe("refreshCatalogByType", () => {
  it("agent 类型：从 Agent 加载并投影", async () => {
    const { tenantId, userIdentityId } = await seedContext();
    await seedAgent(tenantId, userIdentityId, "finance");
    await seedAgent(tenantId, userIdentityId, "hr");

    const count = await refreshCatalogByType({ tenantId, resourceType: "agent" });
    expect(count).toBe(2);

    const result = await listCatalogOptions({
      tenantId,
      resourceTypes: ["agent"],
    });
    expect(result.items).toHaveLength(2);
    expect(result.items.map((i) => i.display_name)).toEqual(
      expect.arrayContaining(["Agent finance", "Agent hr"]),
    );
  });

  it("skill 类型：从 Skill 加载并投影", async () => {
    const { tenantId, userIdentityId } = await seedContext();
    await seedSkill(tenantId, userIdentityId, "report-gen");

    const count = await refreshCatalogByType({ tenantId, resourceType: "skill" });
    expect(count).toBe(1);

    const result = await listCatalogOptions({
      tenantId,
      resourceTypes: ["skill"],
    });
    expect(result.items).toHaveLength(1);
    expect(result.items[0]?.resource_type).toBe("skill");
  });

  it("tool 类型：从 Tool 加载并投影（join ToolProvider 取 owner）", async () => {
    const { tenantId, userIdentityId } = await seedContext();
    await seedTool(tenantId, userIdentityId, "search-web");

    const count = await refreshCatalogByType({ tenantId, resourceType: "tool" });
    expect(count).toBe(1);

    const result = await listCatalogOptions({
      tenantId,
      resourceTypes: ["tool"],
    });
    expect(result.items).toHaveLength(1);
    expect(result.items[0]?.resource_type).toBe("tool");
    expect(result.items[0]?.owner_user_id).toBe(userIdentityId);
  });

  it("不支持的类型（knowledge/runtime/model/connection）返回 0", async () => {
    const { tenantId } = await seedContext();
    const count = await refreshCatalogByType({
      tenantId,
      resourceType: "knowledge",
    });
    expect(count).toBe(0);
  });

  it("软删的 Agent 不投影", async () => {
    const { tenantId, userIdentityId } = await seedContext();
    const agent = await createAgent({
      tenantId,
      agentKey: "active-agent",
      displayName: "Active Agent",
      ownerUserId: userIdentityId,
      lifecycleState: "enabled",
    });
    // 软删
    await db.update(agentTable).set({ deletedAt: new Date() }).where(eq(agentTable.id, agent.id));

    const count = await refreshCatalogByType({ tenantId, resourceType: "agent" });
    expect(count).toBe(0);
  });

  it("空源（无任何资源）返回 0", async () => {
    const { tenantId } = await seedContext();
    const count = await refreshCatalogByType({ tenantId, resourceType: "agent" });
    expect(count).toBe(0);
  });
});

// ═══════════════════════════════════════════════════════════
// 7. removeCatalogEntry
// ═══════════════════════════════════════════════════════════

describe("removeCatalogEntry", () => {
  it("成功删除存在的条目返回 true", async () => {
    const { tenantId } = await seedContext();
    const entry = await refreshCatalogEntry(buildEntryInput(tenantId));
    const removed = await removeCatalogEntry({
      tenantId,
      resourceType: "agent",
      resourceId: entry.resourceId,
    });
    expect(removed).toBe(true);
    // 确认已删除
    const found = await getCatalogEntryByResource({
      tenantId,
      resourceType: "agent",
      resourceId: entry.resourceId,
    });
    expect(found).toBeNull();
  });

  it("删除不存在的条目返回 false", async () => {
    const { tenantId } = await seedContext();
    const removed = await removeCatalogEntry({
      tenantId,
      resourceType: "agent",
      resourceId: "non-existent",
    });
    expect(removed).toBe(false);
  });
});

// ═══════════════════════════════════════════════════════════
// 8. listCatalogOptions
// ═══════════════════════════════════════════════════════════

describe("listCatalogOptions", () => {
  it("空目录返回空 items + next_cursor=null", async () => {
    const { tenantId } = await seedContext();
    const result = await listCatalogOptions({ tenantId });
    expect(result.items).toHaveLength(0);
    expect(result.next_cursor).toBeNull();
    expect(result.catalog_revision).toBe(0);
  });

  it("按 resourceType 过滤", async () => {
    const { tenantId } = await seedContext();
    await refreshCatalogEntry(
      buildEntryInput(tenantId, { resourceType: "agent", resourceId: "a1" }),
    );
    await refreshCatalogEntry(
      buildEntryInput(tenantId, { resourceType: "skill", resourceId: "s1" }),
    );
    const result = await listCatalogOptions({
      tenantId,
      resourceTypes: ["agent"],
    });
    expect(result.items).toHaveLength(1);
    expect(result.items[0]?.resource_type).toBe("agent");
  });

  it("按 lifecycleState 过滤", async () => {
    const { tenantId } = await seedContext();
    await refreshCatalogEntry(
      buildEntryInput(tenantId, {
        resourceId: "a1",
        lifecycleState: "enabled",
      }),
    );
    await refreshCatalogEntry(
      buildEntryInput(tenantId, {
        resourceId: "a2",
        lifecycleState: "draft",
      }),
    );
    const result = await listCatalogOptions({
      tenantId,
      lifecycleStates: ["enabled"],
    });
    expect(result.items).toHaveLength(1);
    expect(result.items[0]?.lifecycle_state).toBe("enabled");
  });

  it("cursor 分页：limit=2 翻完 5 条", async () => {
    const { tenantId } = await seedContext();
    for (let i = 0; i < 5; i++) {
      await refreshCatalogEntry(buildEntryInput(tenantId, { resourceId: `r-${i}` }));
    }
    // 第一页
    const page1 = await listCatalogOptions({ tenantId, limit: 2 });
    expect(page1.items).toHaveLength(2);
    expect(page1.next_cursor).not.toBeNull();
    // 第二页
    const page2 = await listCatalogOptions({
      tenantId,
      limit: 2,
      cursor: page1.next_cursor,
    });
    expect(page2.items).toHaveLength(2);
    expect(page2.next_cursor).not.toBeNull();
    // 第三页
    const page3 = await listCatalogOptions({
      tenantId,
      limit: 2,
      cursor: page2.next_cursor,
    });
    expect(page3.items).toHaveLength(1);
    expect(page3.next_cursor).toBeNull();
    // 总计 5 条不重复
    const allIds = [...page1.items, ...page2.items, ...page3.items].map((i) => i.resource_id);
    expect(new Set(allIds).size).toBe(5);
  });

  it("limit 上限 200，下限 1", async () => {
    const { tenantId } = await seedContext();
    await refreshCatalogEntry(buildEntryInput(tenantId));
    // limit=0 被钳制为 1
    const result0 = await listCatalogOptions({ tenantId, limit: 0 });
    expect(result0.items).toHaveLength(1);
    // limit=999 被钳制为 200
    const resultBig = await listCatalogOptions({ tenantId, limit: 999 });
    expect(resultBig.items).toHaveLength(1);
  });

  it("跨租户隔离：只返回当前租户的条目", async () => {
    const { tenantId } = await seedContext();
    const extraTenantId = "00000000-0000-4000-8000-000000000099";
    await seedExtraTenant(extraTenantId, "extra");

    await refreshCatalogEntry(buildEntryInput(tenantId, { resourceId: "own" }));
    await refreshCatalogEntry(buildEntryInput(extraTenantId, { resourceId: "other" }));

    const result = await listCatalogOptions({ tenantId });
    expect(result.items).toHaveLength(1);
    expect(result.items[0]?.resource_id).toBe("own");
  });

  it("非法 resourceType 抛 CatalogQueryError", async () => {
    const { tenantId } = await seedContext();
    await expect(
      listCatalogOptions({
        tenantId,
        resourceTypes: ["unknown" as never],
      }),
    ).rejects.toThrow(CatalogQueryError);
  });
});

// ═══════════════════════════════════════════════════════════
// 9. searchCatalog
// ═══════════════════════════════════════════════════════════

describe("searchCatalog", () => {
  it("匹配 displayName", async () => {
    const { tenantId } = await seedContext();
    await refreshCatalogEntry(
      buildEntryInput(tenantId, {
        resourceId: "a1",
        displayName: "财务报表 Agent",
      }),
    );
    await refreshCatalogEntry(
      buildEntryInput(tenantId, {
        resourceId: "a2",
        displayName: "人力资源 Agent",
      }),
    );
    const result = await searchCatalog({ tenantId, query: "财务" });
    expect(result.items).toHaveLength(1);
    expect(result.items[0]?.display_name).toBe("财务报表 Agent");
  });

  it("匹配 description", async () => {
    const { tenantId } = await seedContext();
    await refreshCatalogEntry(
      buildEntryInput(tenantId, {
        resourceId: "a1",
        displayName: "Agent A",
        description: "处理月度财务报表",
      }),
    );
    const result = await searchCatalog({ tenantId, query: "月度" });
    expect(result.items).toHaveLength(1);
    expect(result.items[0]?.resource_id).toBe("a1");
  });

  it("无匹配返回空 items", async () => {
    const { tenantId } = await seedContext();
    await refreshCatalogEntry(buildEntryInput(tenantId, { displayName: "Agent A" }));
    const result = await searchCatalog({ tenantId, query: "不存在的关键词" });
    expect(result.items).toHaveLength(0);
    expect(result.next_cursor).toBeNull();
  });

  it("空 query 抛 CatalogQueryError", async () => {
    const { tenantId } = await seedContext();
    await expect(searchCatalog({ tenantId, query: "" })).rejects.toThrow(CatalogQueryError);
    await expect(searchCatalog({ tenantId, query: "   " })).rejects.toThrow(CatalogQueryError);
  });

  it("带 resourceType 过滤", async () => {
    const { tenantId } = await seedContext();
    await refreshCatalogEntry(
      buildEntryInput(tenantId, {
        resourceType: "agent",
        resourceId: "a1",
        displayName: "财务 Agent",
      }),
    );
    await refreshCatalogEntry(
      buildEntryInput(tenantId, {
        resourceType: "skill",
        resourceId: "s1",
        displayName: "财务 Skill",
      }),
    );
    const result = await searchCatalog({
      tenantId,
      query: "财务",
      resourceTypes: ["agent"],
    });
    expect(result.items).toHaveLength(1);
    expect(result.items[0]?.resource_type).toBe("agent");
  });
});

// ═══════════════════════════════════════════════════════════
// 10. 单条查询
// ═══════════════════════════════════════════════════════════

describe("getCatalogEntryById / getCatalogEntryByResource", () => {
  it("getCatalogEntryById 存在返回行", async () => {
    const { tenantId } = await seedContext();
    const entry = await refreshCatalogEntry(buildEntryInput(tenantId));
    const found = await getCatalogEntryById({
      tenantId,
      entryId: entry.id,
    });
    expect(found).not.toBeNull();
    expect(found?.id).toBe(entry.id);
  });

  it("getCatalogEntryById 不存在返回 null", async () => {
    const { tenantId } = await seedContext();
    const found = await getCatalogEntryById({
      tenantId,
      entryId: "non-existent",
    });
    expect(found).toBeNull();
  });

  it("getCatalogEntryByResource 存在返回行", async () => {
    const { tenantId } = await seedContext();
    await refreshCatalogEntry(
      buildEntryInput(tenantId, {
        resourceType: "skill",
        resourceId: "skill-001",
      }),
    );
    const found = await getCatalogEntryByResource({
      tenantId,
      resourceType: "skill",
      resourceId: "skill-001",
    });
    expect(found).not.toBeNull();
    expect(found?.resourceType).toBe("skill");
    expect(found?.resourceId).toBe("skill-001");
  });

  it("getCatalogEntryByResource 非法 resourceType 抛 CatalogQueryError", async () => {
    const { tenantId } = await seedContext();
    await expect(
      getCatalogEntryByResource({
        tenantId,
        resourceType: "unknown" as never,
        resourceId: "any",
      }),
    ).rejects.toThrow(CatalogQueryError);
  });
});

// ═══════════════════════════════════════════════════════════
// 11. GET /api/v1/catalog/options — Employee Catalog API
// ═══════════════════════════════════════════════════════════

describe("GET /api/v1/catalog/options", () => {
  it("空目录返回 200 + 空 items + ETag 头", async () => {
    await seedContext();
    const request = buildV11Request({
      audience: "employee",
      method: "GET",
      path: "/catalog/options",
    });
    const response = await catalogOptionsGET(request);
    expect(response.status).toBe(200);
    const body = (await response.json()) as {
      items: unknown[];
      next_cursor: string | null;
      catalog_revision: number;
    };
    expect(body.items).toHaveLength(0);
    expect(body.next_cursor).toBeNull();
    expect(body.catalog_revision).toBe(0);
    // ETag 头
    const etag = response.headers.get("etag");
    expect(etag).not.toBeNull();
    expect(etag).toContain("catalog-");
  });

  it("成功返回目录条目", async () => {
    const { tenantId } = await seedContext();
    await refreshCatalogEntry(
      buildEntryInput(tenantId, {
        resourceId: "agent-001",
        displayName: "财务 Agent",
      }),
    );
    const request = buildV11Request({
      audience: "employee",
      method: "GET",
      path: "/catalog/options",
    });
    const response = await catalogOptionsGET(request);
    expect(response.status).toBe(200);
    const body = (await response.json()) as {
      items: { resource_id: string; display_name: string }[];
    };
    expect(body.items).toHaveLength(1);
    expect(body.items[0]?.resource_id).toBe("agent-001");
    expect(body.items[0]?.display_name).toBe("财务 Agent");
  });

  it("resource_type 查询参数过滤", async () => {
    const { tenantId } = await seedContext();
    await refreshCatalogEntry(
      buildEntryInput(tenantId, { resourceType: "agent", resourceId: "a1" }),
    );
    await refreshCatalogEntry(
      buildEntryInput(tenantId, { resourceType: "skill", resourceId: "s1" }),
    );
    const request = buildV11Request({
      audience: "employee",
      method: "GET",
      path: "/catalog/options?resource_type=skill",
    });
    const response = await catalogOptionsGET(request);
    expect(response.status).toBe(200);
    const body = (await response.json()) as {
      items: { resource_type: string }[];
    };
    expect(body.items).toHaveLength(1);
    expect(body.items[0]?.resource_type).toBe("skill");
  });

  it("lifecycle_state 查询参数过滤", async () => {
    const { tenantId } = await seedContext();
    await refreshCatalogEntry(
      buildEntryInput(tenantId, {
        resourceId: "a1",
        lifecycleState: "enabled",
      }),
    );
    await refreshCatalogEntry(
      buildEntryInput(tenantId, {
        resourceId: "a2",
        lifecycleState: "draft",
      }),
    );
    const request = buildV11Request({
      audience: "employee",
      method: "GET",
      path: "/catalog/options?lifecycle_state=enabled",
    });
    const response = await catalogOptionsGET(request);
    expect(response.status).toBe(200);
    const body = (await response.json()) as {
      items: { lifecycle_state: string }[];
    };
    expect(body.items).toHaveLength(1);
    expect(body.items[0]?.lifecycle_state).toBe("enabled");
  });

  it("limit 查询参数限制返回数量", async () => {
    const { tenantId } = await seedContext();
    for (let i = 0; i < 3; i++) {
      await refreshCatalogEntry(buildEntryInput(tenantId, { resourceId: `r-${i}` }));
    }
    const request = buildV11Request({
      audience: "employee",
      method: "GET",
      path: "/catalog/options?limit=2",
    });
    const response = await catalogOptionsGET(request);
    expect(response.status).toBe(200);
    const body = (await response.json()) as {
      items: unknown[];
      next_cursor: string | null;
    };
    expect(body.items).toHaveLength(2);
    expect(body.next_cursor).not.toBeNull();
  });

  it("q 查询参数搜索", async () => {
    const { tenantId } = await seedContext();
    await refreshCatalogEntry(
      buildEntryInput(tenantId, {
        resourceId: "a1",
        displayName: "财务报表 Agent",
      }),
    );
    await refreshCatalogEntry(
      buildEntryInput(tenantId, {
        resourceId: "a2",
        displayName: "人力资源 Agent",
      }),
    );
    const request = buildV11Request({
      audience: "employee",
      method: "GET",
      path: "/catalog/options?q=财务",
    });
    const response = await catalogOptionsGET(request);
    expect(response.status).toBe(200);
    const body = (await response.json()) as {
      items: { display_name: string }[];
    };
    expect(body.items).toHaveLength(1);
    expect(body.items[0]?.display_name).toBe("财务报表 Agent");
  });

  it("If-None-Match 匹配当前 revision 返回 304", async () => {
    const { tenantId } = await seedContext();
    await refreshCatalogEntry(buildEntryInput(tenantId));
    const currentRevision = await getCurrentCatalogRevision({
      tenantId,
      audience: "employee",
    });
    const etag = buildCatalogRevisionEtag(tenantId, "employee", currentRevision);
    const request = buildV11Request({
      audience: "employee",
      method: "GET",
      path: "/catalog/options",
      headers: { "if-none-match": `"${etag}"` },
    });
    const response = await catalogOptionsGET(request);
    expect(response.status).toBe(304);
    // 304 响应也应带 ETag
    const respEtag = response.headers.get("etag");
    expect(respEtag).not.toBeNull();
  });

  it("If-None-Match 不匹配返回 200 + 最新目录", async () => {
    const { tenantId } = await seedContext();
    await refreshCatalogEntry(buildEntryInput(tenantId));
    const currentRevision = await getCurrentCatalogRevision({
      tenantId,
      audience: "employee",
    });
    // 用旧 revision 构造 If-None-Match
    const staleEtag = buildCatalogRevisionEtag(tenantId, "employee", currentRevision - 1);
    const request = buildV11Request({
      audience: "employee",
      method: "GET",
      path: "/catalog/options",
      headers: { "if-none-match": `"${staleEtag}"` },
    });
    const response = await catalogOptionsGET(request);
    expect(response.status).toBe(200);
    const body = (await response.json()) as { items: unknown[] };
    expect(body.items).toHaveLength(1);
  });

  it("If-None-Match 非法格式返回 400 CATALOG_REVISION_INVALID", async () => {
    await seedContext();
    const request = buildV11Request({
      audience: "employee",
      method: "GET",
      path: "/catalog/options",
      headers: { "if-none-match": '"route-set-5"' },
    });
    const response = await catalogOptionsGET(request);
    expect(response.status).toBe(400);
    const body = (await response.json()) as {
      error: { code: string; request_id: string };
    };
    expect(body.error.code).toBe("CATALOG_REVISION_INVALID");
  });

  it("非法 resource_type 返回 400 REQUEST_SCHEMA_INVALID", async () => {
    await seedContext();
    const request = buildV11Request({
      audience: "employee",
      method: "GET",
      path: "/catalog/options?resource_type=unknown",
    });
    const response = await catalogOptionsGET(request);
    expect(response.status).toBe(400);
    const body = (await response.json()) as {
      error: { code: string; request_id: string };
    };
    expect(body.error.code).toBe("REQUEST_SCHEMA_INVALID");
  });

  it("非法 limit（0/负数/非数字）返回 400 REQUEST_SCHEMA_INVALID", async () => {
    await seedContext();
    const request = buildV11Request({
      audience: "employee",
      method: "GET",
      path: "/catalog/options?limit=0",
    });
    const response = await catalogOptionsGET(request);
    expect(response.status).toBe(400);
    const body = (await response.json()) as {
      error: { code: string };
    };
    expect(body.error.code).toBe("REQUEST_SCHEMA_INVALID");
  });

  it("响应 ETag 头格式为 catalog-{tenantId}-employee-{revisionNo}", async () => {
    const { tenantId } = await seedContext();
    await refreshCatalogEntry(buildEntryInput(tenantId));
    const request = buildV11Request({
      audience: "employee",
      method: "GET",
      path: "/catalog/options",
    });
    const response = await catalogOptionsGET(request);
    expect(response.status).toBe(200);
    const etag = response.headers.get("etag");
    expect(etag).not.toBeNull();
    // 去引号后应可被 parseCatalogRevisionEtag 解析
    const bare = etag?.replace(/^"|"$/g, "") ?? "";
    expect(bare.startsWith("catalog-")).toBe(true);
    const revisionNo = parseCatalogRevisionEtag(bare);
    expect(revisionNo).toBeGreaterThan(0);
  });

  it("cursor 分页：limit=2 翻完 4 条", async () => {
    const { tenantId } = await seedContext();
    for (let i = 0; i < 4; i++) {
      await refreshCatalogEntry(buildEntryInput(tenantId, { resourceId: `r-${i}` }));
    }
    // 第一页
    const req1 = buildV11Request({
      audience: "employee",
      method: "GET",
      path: "/catalog/options?limit=2",
    });
    const resp1 = await catalogOptionsGET(req1);
    expect(resp1.status).toBe(200);
    const body1 = (await resp1.json()) as {
      items: unknown[];
      next_cursor: string | null;
    };
    expect(body1.items).toHaveLength(2);
    expect(body1.next_cursor).not.toBeNull();
    // 第二页
    const req2 = buildV11Request({
      audience: "employee",
      method: "GET",
      path: `/catalog/options?limit=2&cursor=${encodeURIComponent(body1.next_cursor as string)}`,
    });
    const resp2 = await catalogOptionsGET(req2);
    expect(resp2.status).toBe(200);
    const body2 = (await resp2.json()) as {
      items: unknown[];
      next_cursor: string | null;
    };
    expect(body2.items).toHaveLength(2);
    expect(body2.next_cursor).toBeNull();
  });
});
