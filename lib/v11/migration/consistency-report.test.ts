/**
 * S13-W03 一致性核对报告生成器集成测试（真实 MySQL 8 Testcontainers）。
 *
 * 覆盖：
 * - 空数据库：所有 identity 域检查跳过，报告通过
 * - 迁移后一致性：identity 域迁移后计数一致、引用完整、租户边界完整
 * - 计数不一致检测：手动删除 V11 记录导致计数差异，检查失败
 * - 引用完整性检测：手动删除 PrincipalBinding 导致孤儿 RoleActionBinding，检查失败
 * - 迁移状态一致性：异常队列未清零时检查失败
 * - 未实现域检查：自动跳过生成 info 检查
 * - 报告格式化：formatConsistencyReport 生成可读字符串
 *
 * 真实 MySQL 8 Testcontainers，不使用 mock。
 */
import { db } from "@/lib/db/client";
import { role as Role, rolePermission as RolePermission, user as User } from "@/lib/db/schema";
import { resetDatabase } from "@/lib/db/test/mysql-harness";
import { DEFAULT_TENANT_ID, ensureDefaultTenant } from "@/lib/v11/identity/tenant-queries";
import {
  type ConsistencyReport,
  formatConsistencyReport,
  generateConsistencyReport,
  generateDomainConsistencyReport,
  getPrincipalBindingCountByType,
  getRoleActionBindingWithPrincipalCount,
  getV11TableRowCount,
} from "@/lib/v11/migration/consistency-report";
import { createExecutionRunner } from "@/lib/v11/migration/migration-runner";
import { InMemoryMigrationStateStore } from "@/lib/v11/migration/migration-state";
import { createIdentityTransformers } from "@/lib/v11/migration/transformers/identity";
import { getV11TableRegistry } from "@/lib/v11/migration/v11-table-registry";
import { roleActionBinding } from "@/lib/v11/schema/authorization";
import { principalBinding, userIdentity } from "@/lib/v11/schema/identity";
import { eq, sql } from "drizzle-orm";
import { beforeEach, describe, expect, it } from "vitest";

beforeEach(async () => {
  await resetDatabase(db);
  await ensureDefaultTenant();
});

// ═══════════════════════════════════════════════════════════
// 1. 空数据库一致性报告
// ═══════════════════════════════════════════════════════════

describe("S13-W03 空数据库一致性报告", () => {
  it("空数据库所有 identity 检查跳过且报告通过", async () => {
    const report = await generateConsistencyReport();

    expect(report.mappingVersion).toBe("migration-mapping-v1");
    expect(report.passed).toBe(true);
    expect(report.totalFailed).toBe(0);
    expect(report.blockingIssues.length).toBe(0);

    // identity 域检查应全部跳过（源和目标都为空）
    const identityDomain = report.domains.find((d) => d.domain === "identity");
    expect(identityDomain).toBeDefined();
    expect(identityDomain?.passed).toBe(true);
    // 所有 blocking 检查应被跳过
    const blockingChecks = identityDomain?.checks.filter((c) => c.severity === "blocking") ?? [];
    for (const check of blockingChecks) {
      expect(check.skipped).toBe(true);
    }
  });

  it("空数据库报告包含全部 12 个域", async () => {
    const report = await generateConsistencyReport();
    expect(report.domains.length).toBe(12);
  });
});

// ═══════════════════════════════════════════════════════════
// 2. 迁移后一致性验证
// ═══════════════════════════════════════════════════════════

describe("S13-W03 迁移后一致性验证", () => {
  it("identity 域迁移后计数一致、引用完整、租户边界完整", async () => {
    // 准备数据
    await db.insert(User).values({
      id: "user-cons-001",
      externalId: "ext-cons-001",
      email: "cons001@example.com",
      name: "Cons User 001",
    });
    await db.insert(User).values({
      id: "user-cons-002",
      externalId: "ext-cons-002",
      email: "cons002@example.com",
      name: "Cons User 002",
    });
    await db.insert(Role).values({
      id: "role-cons-001",
      key: "cons-admin",
      name: "Cons Admin",
    });
    await db.insert(RolePermission).values({
      roleId: "role-cons-001",
      permission: "skill.write",
    });

    // 执行迁移
    const store = new InMemoryMigrationStateStore();
    const runner = createExecutionRunner(
      store,
      createIdentityTransformers(),
      100,
      false,
      getV11TableRegistry(),
    );
    await runner.runDomain("identity");

    // 生成一致性报告
    const report = await generateConsistencyReport(store);

    expect(report.passed).toBe(true);
    expect(report.totalFailed).toBe(0);
    expect(report.blockingIssues.length).toBe(0);

    // identity 域应全部通过
    const identityDomain = report.domains.find((d) => d.domain === "identity");
    expect(identityDomain?.passed).toBe(true);
    expect(identityDomain?.failedCount).toBe(0);

    // 验证具体检查项
    const checks = identityDomain?.checks ?? [];
    const userUiCheck = checks.find((c) => c.name.includes("UserIdentity 计数一致"));
    expect(userUiCheck?.passed).toBe(true);
    expect(userUiCheck?.expected).toBe(2);
    expect(userUiCheck?.actual).toBe(2);

    const userPbCheck = checks.find((c) => c.name.includes("PrincipalBinding(user) 计数一致"));
    expect(userPbCheck?.passed).toBe(true);

    const rolePbCheck = checks.find((c) => c.name.includes("PrincipalBinding(role) 计数一致"));
    expect(rolePbCheck?.passed).toBe(true);
    expect(rolePbCheck?.expected).toBe(1);
    expect(rolePbCheck?.actual).toBe(1);

    const rabRefCheck = checks.find((c) =>
      c.name.includes("RoleActionBinding → PrincipalBinding 引用完整"),
    );
    expect(rabRefCheck?.passed).toBe(true);

    const uiTenantCheck = checks.find((c) => c.name.includes("UserIdentity 租户边界完整"));
    expect(uiTenantCheck?.passed).toBe(true);

    // 异常队列应清零
    const anomalyCheck = checks.find((c) => c.name.includes("异常队列已清零"));
    expect(anomalyCheck?.passed).toBe(true);
  });
});

// ═══════════════════════════════════════════════════════════
// 3. 计数不一致检测
// ═══════════════════════════════════════════════════════════

describe("S13-W03 计数不一致检测", () => {
  it("手动删除 UserIdentity 导致计数差异时检查失败", async () => {
    await db.insert(User).values({
      id: "user-mismatch-001",
      externalId: "ext-mismatch-001",
      email: "mismatch001@example.com",
    });
    await db.insert(User).values({
      id: "user-mismatch-002",
      externalId: "ext-mismatch-002",
      email: "mismatch002@example.com",
    });

    // 执行迁移
    const store = new InMemoryMigrationStateStore();
    const runner = createExecutionRunner(
      store,
      createIdentityTransformers(),
      100,
      false,
      getV11TableRegistry(),
    );
    await runner.runDomain("identity");

    // 手动删除一条 UserIdentity 模拟数据丢失
    await db.delete(userIdentity).where(eq(userIdentity.id, "user-mismatch-002"));

    const report = await generateConsistencyReport();
    expect(report.passed).toBe(false);
    expect(report.totalFailed).toBeGreaterThan(0);

    const identityDomain = report.domains.find((d) => d.domain === "identity");
    const userUiCheck = identityDomain?.checks.find((c) =>
      c.name.includes("UserIdentity 计数一致"),
    );
    expect(userUiCheck?.passed).toBe(false);
    expect(userUiCheck?.expected).toBe(2);
    expect(userUiCheck?.actual).toBe(1);
  });

  it("源表有数据但目标表未迁移时检查失败", async () => {
    await db.insert(User).values({
      id: "user-not-migrated",
      externalId: "ext-not-migrated",
      email: "notmigrated@example.com",
    });

    // 不执行迁移，直接生成报告
    const report = await generateConsistencyReport();
    expect(report.passed).toBe(false);

    const identityDomain = report.domains.find((d) => d.domain === "identity");
    const userUiCheck = identityDomain?.checks.find((c) =>
      c.name.includes("UserIdentity 计数一致"),
    );
    expect(userUiCheck?.passed).toBe(false);
    expect(userUiCheck?.expected).toBe(1);
    expect(userUiCheck?.actual).toBe(0);
    expect(userUiCheck?.skipped).toBe(false);
  });
});

// ═══════════════════════════════════════════════════════════
// 4. 引用完整性检测
// ═══════════════════════════════════════════════════════════

describe("S13-W03 引用完整性检测", () => {
  it("孤儿 RoleActionBinding 被检测到", async () => {
    await db.insert(Role).values({
      id: "role-orphan-001",
      key: "orphan-admin",
      name: "Orphan Admin",
    });
    await db.insert(RolePermission).values({
      roleId: "role-orphan-001",
      permission: "skill.publish",
    });

    // 执行迁移
    const store = new InMemoryMigrationStateStore();
    const runner = createExecutionRunner(
      store,
      createIdentityTransformers(),
      100,
      false,
      getV11TableRegistry(),
    );
    await runner.runDomain("identity");

    // 禁用 FK 检查后删除 PrincipalBinding，避免 ON DELETE CASCADE 级联删除 RoleActionBinding
    await db.execute(sql`SET FOREIGN_KEY_CHECKS = 0`);
    await db.delete(principalBinding).where(eq(principalBinding.subjectType, "role"));
    await db.execute(sql`SET FOREIGN_KEY_CHECKS = 1`);

    const report = await generateConsistencyReport();
    expect(report.passed).toBe(false);

    const identityDomain = report.domains.find((d) => d.domain === "identity");
    const rabRefCheck = identityDomain?.checks.find((c) =>
      c.name.includes("RoleActionBinding → PrincipalBinding 引用完整"),
    );
    expect(rabRefCheck?.passed).toBe(false);
    expect(rabRefCheck?.actual).toBeGreaterThan(0);
  });
});

// ═══════════════════════════════════════════════════════════
// 5. 迁移状态一致性
// ═══════════════════════════════════════════════════════════

describe("S13-W03 迁移状态一致性", () => {
  it("异常队列未清零时检查失败", async () => {
    const store = new InMemoryMigrationStateStore();
    // 手动记录一条异常
    store.recordAnomaly({
      sourceTable: "User",
      sourceId: "user-anomaly-test",
      reason: "测试异常：externalId 为空",
      batchId: "batch-test",
      recordedAt: new Date().toISOString(),
    });

    const report = await generateConsistencyReport(store);
    expect(report.passed).toBe(false);

    const identityDomain = report.domains.find((d) => d.domain === "identity");
    const anomalyCheck = identityDomain?.checks.find((c) => c.name.includes("异常队列已清零"));
    expect(anomalyCheck?.passed).toBe(false);
    expect(anomalyCheck?.actual).toBe(1);
  });

  it("异常队列为空时检查通过", async () => {
    const store = new InMemoryMigrationStateStore();
    const report = await generateConsistencyReport(store);

    const identityDomain = report.domains.find((d) => d.domain === "identity");
    const anomalyCheck = identityDomain?.checks.find((c) => c.name.includes("异常队列已清零"));
    expect(anomalyCheck?.passed).toBe(true);
    expect(anomalyCheck?.actual).toBe(0);
  });
});

// ═══════════════════════════════════════════════════════════
// 6. 未实现域检查
// ═══════════════════════════════════════════════════════════

describe("S13-W03 未实现域检查", () => {
  it("未实现域生成 info 级跳过检查", async () => {
    const report = await generateDomainConsistencyReport("conversation");

    expect(report.domain).toBe("conversation");
    expect(report.passed).toBe(true); // 无 blocking 检查失败
    expect(report.failedCount).toBe(0);

    // 所有检查应为 info 级且跳过
    for (const check of report.checks) {
      expect(check.severity).toBe("info");
      expect(check.skipped).toBe(true);
      expect(check.passed).toBe(true);
    }
  });

  it("未实现域检查数等于该域映射表数", async () => {
    const report = await generateDomainConsistencyReport("agent_skill");
    // agent_skill 域有 6 张表
    expect(report.checks.length).toBe(6);
  });
});

// ═══════════════════════════════════════════════════════════
// 7. 报告格式化
// ═══════════════════════════════════════════════════════════

describe("S13-W03 formatConsistencyReport", () => {
  it("生成可读字符串包含关键信息", async () => {
    const report = await generateConsistencyReport();
    const formatted = formatConsistencyReport(report);

    expect(formatted).toContain("V11 迁移一致性核对报告");
    expect(formatted).toContain("映射版本: migration-mapping-v1");
    expect(formatted).toContain("总计:");
    expect(formatted).toContain("按域汇总:");
    expect(formatted).toContain("identity:");
  });

  it("通过时显示总体通过", async () => {
    const report = await generateConsistencyReport();
    const formatted = formatConsistencyReport(report);
    expect(formatted).toContain("总体: 通过");
  });

  it("失败时显示阻断性问题", async () => {
    const store = new InMemoryMigrationStateStore();
    store.recordAnomaly({
      sourceTable: "User",
      sourceId: "u1",
      reason: "测试异常",
      batchId: "b1",
      recordedAt: new Date().toISOString(),
    });

    const report = await generateConsistencyReport(store);
    const formatted = formatConsistencyReport(report);

    expect(formatted).toContain("总体: 未通过");
    expect(formatted).toContain("阻断性问题:");
    expect(formatted).toContain("异常队列已清零");
    expect(formatted).toContain("测试异常");
  });
});

// ═══════════════════════════════════════════════════════════
// 8. 便捷计数工具
// ═══════════════════════════════════════════════════════════

describe("S13-W03 便捷计数工具", () => {
  it("getV11TableRowCount 返回正确行数", async () => {
    // Tenant 表已有默认租户
    const tenantCount = await getV11TableRowCount("Tenant");
    expect(tenantCount).toBe(1);

    // 空表
    const uiCount = await getV11TableRowCount("UserIdentity");
    expect(uiCount).toBe(0);

    // 未注册的表返回 0
    const unknownCount = await getV11TableRowCount("UnknownTable");
    expect(unknownCount).toBe(0);
  });

  it("getPrincipalBindingCountByType 按类型返回行数", async () => {
    await db.insert(User).values({
      id: "user-count-001",
      externalId: "ext-count-001",
      email: "count001@example.com",
    });

    const store = new InMemoryMigrationStateStore();
    const runner = createExecutionRunner(
      store,
      createIdentityTransformers(),
      100,
      false,
      getV11TableRegistry(),
    );
    await runner.runDomain("identity");

    const userCount = await getPrincipalBindingCountByType("user");
    expect(userCount).toBe(1);

    const roleCount = await getPrincipalBindingCountByType("role");
    expect(roleCount).toBe(0);
  });

  it("getRoleActionBindingWithPrincipalCount 返回非空 principalBindingId 行数", async () => {
    await db.insert(Role).values({
      id: "role-count-001",
      key: "count-admin",
      name: "Count Admin",
    });
    await db.insert(RolePermission).values({
      roleId: "role-count-001",
      permission: "skill.publish",
    });

    const store = new InMemoryMigrationStateStore();
    const runner = createExecutionRunner(
      store,
      createIdentityTransformers(),
      100,
      false,
      getV11TableRegistry(),
    );
    await runner.runDomain("identity");

    const count = await getRoleActionBindingWithPrincipalCount();
    expect(count).toBeGreaterThan(0);
  });
});

// ═══════════════════════════════════════════════════════════
// 9. 完整迁移流程一致性
// ═══════════════════════════════════════════════════════════

describe("S13-W03 完整迁移流程一致性", () => {
  it("迁移 → 一致性报告 → 二次迁移 → 一致性报告 通过", async () => {
    await db.insert(User).values({
      id: "user-flow-001",
      externalId: "ext-flow-001",
      email: "flow001@example.com",
    });
    await db.insert(Role).values({
      id: "role-flow-001",
      key: "flow-admin",
      name: "Flow Admin",
    });
    await db.insert(RolePermission).values({
      roleId: "role-flow-001",
      permission: "skill.write",
    });

    const store = new InMemoryMigrationStateStore();
    const transformers = createIdentityTransformers();

    // 第一次迁移
    const runner1 = createExecutionRunner(store, transformers, 100, false, getV11TableRegistry());
    await runner1.runDomain("identity");

    // 第一次一致性报告
    const report1 = await generateConsistencyReport(store);
    expect(report1.passed).toBe(true);

    // 二次迁移（幂等，应全部跳过）
    const runner2 = createExecutionRunner(store, transformers, 100, false, getV11TableRegistry());
    await runner2.runDomain("identity");

    // 二次一致性报告（应仍通过）
    const report2 = await generateConsistencyReport(store);
    expect(report2.passed).toBe(true);
    expect(report2.totalFailed).toBe(0);
  });
});
