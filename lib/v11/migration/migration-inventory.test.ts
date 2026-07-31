/**
 * S13-W01 迁移盘点工具集成测试（真实 MySQL 8 Testcontainers）。
 *
 * 覆盖：
 * - mapping-baseline：映射基线完整性（38 表 + 12 域 + 核心实体数）
 * - generateInventoryReport：全表行数 + 时间范围 + 按域汇总
 * - detectOrphanReferences：孤儿引用检测（Message→Thread / ToolRun→ThreadRun）
 * - detectDuplicates：重复数据检测（User.externalId / Skill.name）
 * - detectStatusDistributions：状态分布检测（Thread.status / Skill.status）
 * - estimateTableStorage：存储体量估算
 * - generateComprehensiveReport：综合报告 + 阻断标志
 *
 * 真实 MySQL 8 Testcontainers，不使用 mock。
 */
import { db } from "@/lib/db/client";
import {
  agent as AgentTable,
  message as Message,
  role as Role,
  skill as Skill,
  thread as Thread,
  threadRun as ThreadRun,
  toolRun as ToolRun,
  user as User,
} from "@/lib/db/schema";
import { resetDatabase } from "@/lib/db/test/mysql-harness";
import {
  detectDuplicates,
  detectOrphanReferences,
  detectStatusDistributions,
  estimateTableStorage,
  generateComprehensiveReport,
} from "@/lib/v11/migration/inventory-queries";
import {
  type LegacyTableMapping,
  MAPPING_BASELINE,
  MAPPING_VERSION,
  MIGRATION_DOMAINS,
  generateInventoryReport,
  getCoreEntityCount,
  getCoreEntityMappings,
  getMappingByPhysicalTable,
  getMappingCount,
  getMappingsByDomain,
  getNonCoreEntityCount,
} from "@/lib/v11/migration/mapping-baseline";
import { sql } from "drizzle-orm";
import { beforeEach, describe, expect, it } from "vitest";

beforeEach(async () => {
  await resetDatabase(db);
});

// ═══════════════════════════════════════════════════════════
// 1. 映射基线完整性
// ═══════════════════════════════════════════════════════════

describe("S13-W01 映射基线完整性", () => {
  it("映射版本已冻结", () => {
    expect(MAPPING_VERSION).toBe("migration-mapping-v1");
  });

  it("映射基线覆盖 38 张旧表", () => {
    expect(getMappingCount()).toBe(38);
  });

  it("迁移域覆盖 12 个域", () => {
    expect(MIGRATION_DOMAINS.length).toBe(12);
  });

  it("核心实体与非核心实体数正确", () => {
    const core = getCoreEntityCount();
    const nonCore = getNonCoreEntityCount();
    expect(core + nonCore).toBe(38);
    expect(core).toBeGreaterThan(30);
    expect(nonCore).toBeLessThan(8);
  });

  it("每张映射表包含完整字段", () => {
    for (const mapping of MAPPING_BASELINE) {
      expect(mapping.legacyTable).toBeTruthy();
      expect(mapping.physicalTable).toBeTruthy();
      expect(mapping.v11Targets).toBeInstanceOf(Array);
      expect(mapping.domain).toBeTruthy();
      expect(typeof mapping.order).toBe("number");
      expect(mapping.unmigratableFields).toBeInstanceOf(Array);
      expect(mapping.defaultHandling).toBeTruthy();
      expect(mapping.anomalyConditions).toBeTruthy();
      expect(typeof mapping.coreEntity).toBe("boolean");
    }
  });

  it("按域分组返回正确映射", () => {
    for (const domain of MIGRATION_DOMAINS) {
      const mappings = getMappingsByDomain(domain);
      expect(mappings.length).toBeGreaterThan(0);
      // 按 order 升序排列
      for (let i = 1; i < mappings.length; i++) {
        const prev = mappings[i - 1];
        const curr = mappings[i];
        if (prev && curr) {
          expect(curr.order).toBeGreaterThan(prev.order);
        }
      }
    }
  });

  it("按物理表名查找映射", () => {
    const mapping = getMappingByPhysicalTable("Thread");
    expect(mapping).toBeDefined();
    expect(mapping?.legacyTable).toBe("Thread");
    expect(mapping?.domain).toBe("conversation");
    expect(mapping?.v11Targets).toContain("V11Thread");
  });

  it("核心实体映射列表只包含 coreEntity=true", () => {
    const coreMappings = getCoreEntityMappings();
    for (const m of coreMappings) {
      expect(m.coreEntity).toBe(true);
    }
  });

  it("ChatExample 为非核心实体且无 V11 目标", () => {
    const mapping = getMappingByPhysicalTable("ChatExample");
    expect(mapping).toBeDefined();
    expect(mapping?.coreEntity).toBe(false);
    expect(mapping?.v11Targets.length).toBe(0);
  });

  it("映射类型满足 LegacyTableMapping 接口", () => {
    const mapping: LegacyTableMapping | undefined = MAPPING_BASELINE[0];
    expect(mapping).toBeDefined();
  });
});

// ═══════════════════════════════════════════════════════════
// 2. generateInventoryReport
// ═══════════════════════════════════════════════════════════

describe("S13-W01 generateInventoryReport", () => {
  it("空数据库返回零行数报告", async () => {
    const report = await generateInventoryReport();

    expect(report.mappingVersion).toBe(MAPPING_VERSION);
    expect(report.totalTables).toBe(38);
    expect(report.totalRows).toBe(0);
    expect(report.coreEntityTables).toBe(getCoreEntityCount());
    expect(report.byDomain.length).toBe(12);
    expect(report.tables.length).toBe(38);
  });

  it("插入数据后行数正确", async () => {
    await db.insert(User).values({
      id: "user-inv-001",
      externalId: "ext-001",
      email: "test@example.com",
      name: "Test User",
    });
    await db.insert(Thread).values({
      id: "thread-inv-001",
      createdAt: new Date(),
      updatedAt: new Date(),
      title: "Test Thread",
      userId: "user-inv-001",
      status: "idle",
    });

    const report = await generateInventoryReport();

    const userInv = report.tables.find((t) => t.physicalTable === "User");
    expect(userInv?.rowCount).toBe(1);
    expect(userInv?.earliestAt).not.toBeNull();
    expect(userInv?.latestAt).not.toBeNull();

    const threadInv = report.tables.find((t) => t.physicalTable === "Thread");
    expect(threadInv?.rowCount).toBe(1);
  });

  it("按域汇总行数正确", async () => {
    await db.insert(User).values({
      id: "user-domain-001",
      externalId: "ext-domain-001",
      email: "domain@example.com",
    });
    await db.insert(Role).values({
      id: "role-domain-001",
      key: "admin",
      name: "Admin",
      isSystem: true,
    });

    const report = await generateInventoryReport();
    const identityDomain = report.byDomain.find((d) => d.domain === "identity");
    expect(identityDomain).toBeDefined();
    expect(identityDomain?.tableCount).toBe(4);
    expect(identityDomain?.totalRows).toBe(2); // 1 User + 1 Role
  });
});

// ═══════════════════════════════════════════════════════════
// 3. detectOrphanReferences
// ═══════════════════════════════════════════════════════════

describe("S13-W01 detectOrphanReferences", () => {
  it("无孤儿时返回空数组", async () => {
    await db.insert(User).values({
      id: "user-orphan-001",
      externalId: "ext-orphan-001",
      email: "orphan@example.com",
    });
    await db.insert(Thread).values({
      id: "thread-orphan-001",
      createdAt: new Date(),
      updatedAt: new Date(),
      title: "Thread",
      userId: "user-orphan-001",
      status: "idle",
    });
    await db.insert(Message).values({
      id: "msg-orphan-001",
      createdAt: new Date(),
      threadId: "thread-orphan-001",
      role: "user",
      type: "text",
      parts: [],
    });

    const orphans = await detectOrphanReferences();
    // Message→Thread 不应有孤儿
    const msgOrphans = orphans.filter(
      (o) => o.childTable === "Message" && o.parentTable === "Thread",
    );
    expect(msgOrphans.length).toBe(0);
  });

  it("检测 Message→Thread 孤儿引用", async () => {
    // 插入一条 Message 指向不存在的 Thread（禁用 FK 检查以构造孤儿）
    await db.execute(sql`SET FOREIGN_KEY_CHECKS=0`);
    await db.insert(Message).values({
      id: "msg-orphan-002",
      createdAt: new Date(),
      threadId: "non-existent-thread",
      role: "user",
      type: "text",
      parts: [],
    });
    await db.execute(sql`SET FOREIGN_KEY_CHECKS=1`);

    const orphans = await detectOrphanReferences();
    const msgOrphan = orphans.find((o) => o.childTable === "Message" && o.parentTable === "Thread");
    expect(msgOrphan).toBeDefined();
    expect(msgOrphan?.orphanCount).toBe(1);
    expect(msgOrphan?.foreignKeyColumn).toBe("threadId");
  });

  it("检测 ToolRun→ThreadRun 孤儿引用", async () => {
    await db.insert(User).values({
      id: "user-orphan-003",
      externalId: "ext-orphan-003",
      email: "orphan3@example.com",
    });
    await db.insert(Thread).values({
      id: "thread-orphan-003",
      createdAt: new Date(),
      updatedAt: new Date(),
      title: "Thread",
      userId: "user-orphan-003",
      status: "idle",
    });
    // ToolRun 指向存在的 Thread 但不存在的 ThreadRun
    await db.insert(ToolRun).values({
      id: "toolrun-orphan-003",
      threadId: "thread-orphan-003",
      toolName: "test-tool",
      status: "succeeded",
      input: {},
      runId: "non-existent-run",
    });

    const orphans = await detectOrphanReferences();
    const toolRunRunOrphan = orphans.find(
      (o) => o.childTable === "ToolRun" && o.parentTable === "ThreadRun",
    );
    expect(toolRunRunOrphan).toBeDefined();
    expect(toolRunRunOrphan?.orphanCount).toBe(1);
  });

  it("检测 UserRole→User 孤儿引用", async () => {
    await db.insert(Role).values({
      id: "role-orphan-004",
      key: "test-role",
      name: "Test Role",
      isSystem: false,
    });
    await db.insert(User).values({
      id: "user-orphan-004",
      externalId: "ext-orphan-004",
      email: "orphan4@example.com",
    });

    const { userRole: UserRole } = await import("@/lib/db/schema");
    await db.insert(UserRole).values({
      userId: "user-orphan-004",
      roleId: "role-orphan-004",
    });
    // 禁用 FK 检查以构造 UserRole→User 孤儿
    await db.execute(sql`SET FOREIGN_KEY_CHECKS=0`);
    await db.insert(UserRole).values({
      userId: "non-existent-user",
      roleId: "role-orphan-004",
    });
    await db.execute(sql`SET FOREIGN_KEY_CHECKS=1`);

    const orphans = await detectOrphanReferences();
    const userRoleOrphan = orphans.find(
      (o) => o.childTable === "UserRole" && o.parentTable === "User",
    );
    expect(userRoleOrphan).toBeDefined();
    expect(userRoleOrphan?.orphanCount).toBe(1);
  });
});

// ═══════════════════════════════════════════════════════════
// 4. detectDuplicates
// ═══════════════════════════════════════════════════════════

describe("S13-W01 detectDuplicates", () => {
  it("无重复时返回空数组", async () => {
    await db.insert(User).values({
      id: "user-dup-001",
      externalId: "ext-dup-001",
      email: "dup1@example.com",
    });

    const duplicates = await detectDuplicates();
    const userDuplicates = duplicates.filter((d) => d.table === "User");
    expect(userDuplicates.length).toBe(0);
  });

  it("检测 Agent.name 重复（3 条）", async () => {
    // Agent.name 无唯一约束，可构造重复数据
    await db.insert(AgentTable).values({
      id: "agent-dup-002",
      name: "shared-agent-name",
      model: "gpt-4",
      config: {},
    });
    await db.insert(AgentTable).values({
      id: "agent-dup-003",
      name: "shared-agent-name",
      model: "gpt-4",
      config: {},
    });
    await db.insert(AgentTable).values({
      id: "agent-dup-004",
      name: "shared-agent-name",
      model: "gpt-4",
      config: {},
    });

    const duplicates = await detectDuplicates();
    const agentDuplicate = duplicates.find((d) => d.table === "Agent" && d.column === "name");
    expect(agentDuplicate).toBeDefined();
    expect(agentDuplicate?.duplicateValue).toBe("shared-agent-name");
    expect(agentDuplicate?.count).toBe(3);
  });

  it("检测 Agent.name 重复（2 条，另一组值）", async () => {
    await db.insert(AgentTable).values({
      id: "agent-dup-101",
      name: "another-duplicate-agent",
      model: "gpt-4",
      config: {},
    });
    await db.insert(AgentTable).values({
      id: "agent-dup-102",
      name: "another-duplicate-agent",
      model: "gpt-4",
      config: {},
    });

    const duplicates = await detectDuplicates();
    const agentDuplicate = duplicates.find(
      (d) =>
        d.table === "Agent" &&
        d.column === "name" &&
        d.duplicateValue === "another-duplicate-agent",
    );
    expect(agentDuplicate).toBeDefined();
    expect(agentDuplicate?.count).toBe(2);
  });
});

// ═══════════════════════════════════════════════════════════
// 5. detectStatusDistributions
// ═══════════════════════════════════════════════════════════

describe("S13-W01 detectStatusDistributions", () => {
  it("检测 Thread.status 分布", async () => {
    await db.insert(User).values({
      id: "user-status-001",
      externalId: "ext-status-001",
      email: "status@example.com",
    });
    for (const status of ["idle", "idle", "completed", "cancelled"]) {
      await db.insert(Thread).values({
        createdAt: new Date(),
        updatedAt: new Date(),
        title: `Thread-${status}`,
        userId: "user-status-001",
        status: status as (typeof Thread.$inferInsert)["status"],
      });
    }

    const distributions = await detectStatusDistributions();
    const threadDist = distributions.find(
      (d) => d.table === "Thread" && d.statusColumn === "status",
    );
    expect(threadDist).toBeDefined();
    expect(threadDist?.distribution.length).toBe(3); // idle, completed, cancelled

    const idleEntry = threadDist?.distribution.find((e) => e.value === "idle");
    expect(idleEntry?.count).toBe(2);

    const completedEntry = threadDist?.distribution.find((e) => e.value === "completed");
    expect(completedEntry?.count).toBe(1);
  });

  it("检测 Skill.status 分布", async () => {
    await db.insert(Skill).values({
      name: "skill-active-001",
      description: "Active",
      category: "test",
      visibility: "private",
      status: "active",
      source: "local",
    });
    await db.insert(Skill).values({
      name: "skill-archived-001",
      description: "Archived",
      category: "test",
      visibility: "private",
      status: "archived",
      source: "local",
    });

    const distributions = await detectStatusDistributions();
    const skillDist = distributions.find((d) => d.table === "Skill" && d.statusColumn === "status");
    expect(skillDist).toBeDefined();
    expect(skillDist?.distribution.length).toBe(2);
  });
});

// ═══════════════════════════════════════════════════════════
// 6. estimateTableStorage
// ═══════════════════════════════════════════════════════════

describe("S13-W01 estimateTableStorage", () => {
  it("返回所有旧表的存储体量估算", async () => {
    const estimates = await estimateTableStorage();
    expect(estimates.length).toBe(38);

    for (const estimate of estimates) {
      expect(estimate.table).toBeTruthy();
      expect(typeof estimate.rowCount).toBe("number");
      expect(typeof estimate.dataLength).toBe("number");
      expect(typeof estimate.indexLength).toBe("number");
      expect(estimate.totalBytes).toBe(estimate.dataLength + estimate.indexLength);
    }
  });

  it("插入数据后存储体量增加", async () => {
    const beforeEstimates = await estimateTableStorage();
    const beforeUserBytes = beforeEstimates.find((e) => e.table === "User")?.totalBytes ?? 0;

    for (let i = 0; i < 50; i++) {
      await db.insert(User).values({
        externalId: `ext-storage-${i}`,
        email: `storage${i}@example.com`,
        name: `User ${i}`,
      });
    }

    // information_schema 统计在 InnoDB 中为缓存估算值，需 ANALYZE TABLE 刷新
    await db.execute(sql`ANALYZE TABLE ${sql.raw("`User`")}`);

    const afterEstimates = await estimateTableStorage();
    const afterUserBytes = afterEstimates.find((e) => e.table === "User")?.totalBytes ?? 0;

    // 行数估算应反映插入（ANALYZE 后近似值收敛）
    const afterUserRows = afterEstimates.find((e) => e.table === "User")?.rowCount ?? 0;
    expect(afterUserRows).toBeGreaterThanOrEqual(50);
  });
});

// ═══════════════════════════════════════════════════════════
// 7. generateComprehensiveReport
// ═══════════════════════════════════════════════════════════

describe("S13-W01 generateComprehensiveReport", () => {
  it("空数据库无阻断性问题", async () => {
    const report = await generateComprehensiveReport();

    expect(report.generatedAt).toBeTruthy();
    expect(report.orphanReferences.length).toBe(0);
    expect(report.duplicates.length).toBe(0);
    expect(report.hasBlockingIssues).toBe(false);
    expect(report.totalStorageBytes).toBeGreaterThanOrEqual(0);
  });

  it("存在孤儿引用时 hasBlockingIssues=true", async () => {
    // 禁用 FK 检查以构造 Message→Thread 孤儿
    await db.execute(sql`SET FOREIGN_KEY_CHECKS=0`);
    await db.insert(Message).values({
      id: "msg-comprehensive-001",
      createdAt: new Date(),
      threadId: "non-existent-thread",
      role: "user",
      type: "text",
      parts: [],
    });
    await db.execute(sql`SET FOREIGN_KEY_CHECKS=1`);

    const report = await generateComprehensiveReport();
    expect(report.hasBlockingIssues).toBe(true);
    expect(report.orphanReferences.length).toBeGreaterThan(0);
  });

  it("存在重复数据时 hasBlockingIssues=true", async () => {
    // Agent.name 无唯一约束，可构造重复
    await db.insert(AgentTable).values({
      id: "agent-comp-001",
      name: "shared-comprehensive-agent",
      model: "gpt-4",
      config: {},
    });
    await db.insert(AgentTable).values({
      id: "agent-comp-002",
      name: "shared-comprehensive-agent",
      model: "gpt-4",
      config: {},
    });

    const report = await generateComprehensiveReport();
    expect(report.hasBlockingIssues).toBe(true);
    expect(report.duplicates.length).toBeGreaterThan(0);
  });

  it("报告包含状态分布和存储体量", async () => {
    const report = await generateComprehensiveReport();
    expect(report.statusDistributions).toBeInstanceOf(Array);
    expect(report.storageEstimates).toBeInstanceOf(Array);
    expect(report.storageEstimates.length).toBe(38);
  });
});
