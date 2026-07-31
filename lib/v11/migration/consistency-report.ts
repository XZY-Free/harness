/**
 * S13-W03 历史数据回填一致性核对报告生成器。
 *
 * 事实源：../v11-agentkit-platform-development-plan/13-migration-cutover-and-release.md §S13-W03
 *         （核对每个 Thread 的正式消息数、顺序、时间、采用分支、附件和主 Agent；
 *           核对 Tool/Effect、Child、Job、Artifact、Memory 和 Audit 的关系闭合与租户边界；
 *           产出机器可读与人可审阅报告，差异未解释前不进入切换窗口）。
 *
 * 设计：
 * - 迁移后运行，对比源表（旧）与目标表（V11）的计数、引用完整性和租户边界。
 * - 每个检查返回 passed/failed + 预期/实际值 + 详情。
 * - 阻断性检查（blocking）未通过时不进入切换窗口。
 * - 按域注册检查，未迁移的域检查自动跳过（target 表为空时不阻断）。
 */
import { db } from "@/lib/db/client";
import {
  MAPPING_BASELINE,
  MAPPING_VERSION,
  MIGRATION_DOMAINS,
  type MigrationDomain,
} from "@/lib/v11/migration/mapping-baseline";
import type { MigrationStateStore } from "@/lib/v11/migration/migration-state";
import { roleActionBinding } from "@/lib/v11/schema/authorization";
import { principalBinding, tenant, userIdentity } from "@/lib/v11/schema/identity";
import { count, eq, isNotNull, sql } from "drizzle-orm";

// ─── 报告类型 ──────────────────────────────────────────────

/** 检查严重级别。 */
export type CheckSeverity = "blocking" | "warning" | "info";

/** 单项一致性检查结果。 */
export interface ConsistencyCheck {
  /** 检查名称。 */
  readonly name: string;
  /** 所属迁移域。 */
  readonly domain: MigrationDomain;
  /** 严重级别。 */
  readonly severity: CheckSeverity;
  /** 是否通过。 */
  readonly passed: boolean;
  /** 预期值。 */
  readonly expected: number;
  /** 实际值。 */
  readonly actual: number;
  /** 详情（失败时描述差异）。 */
  readonly details: string;
  /** 是否跳过（目标表未迁移，不阻断）。 */
  readonly skipped: boolean;
}

/** 单域一致性报告。 */
export interface DomainConsistencyReport {
  /** 迁移域。 */
  readonly domain: MigrationDomain;
  /** 检查列表。 */
  readonly checks: readonly ConsistencyCheck[];
  /** 是否全部通过（仅 blocking 检查参与判定）。 */
  readonly passed: boolean;
  /** 通过检查数。 */
  readonly passedCount: number;
  /** 失败检查数（仅 blocking）。 */
  readonly failedCount: number;
  /** 跳过检查数。 */
  readonly skippedCount: number;
}

/** 完整一致性核对报告。 */
export interface ConsistencyReport {
  /** 映射版本。 */
  readonly mappingVersion: typeof MAPPING_VERSION;
  /** 生成时间（ISO 字符串）。 */
  readonly generatedAt: string;
  /** 按域汇总。 */
  readonly domains: readonly DomainConsistencyReport[];
  /** 总检查数。 */
  readonly totalChecks: number;
  /** 总通过数。 */
  readonly totalPassed: number;
  /** 总失败数（blocking）。 */
  readonly totalFailed: number;
  /** 总跳过数。 */
  readonly totalSkipped: number;
  /** 阻断性问题列表。 */
  readonly blockingIssues: readonly string[];
  /** 是否全部通过（所有 blocking 检查通过）。 */
  readonly passed: boolean;
}

// ─── 检查执行器 ────────────────────────────────────────────

/** 源表行数查询（旧表）。 */
async function getSourceCount(physicalTable: string): Promise<number> {
  const [rows] = (await db.execute(
    sql`SELECT COUNT(*) as total FROM ${sql.raw(`\`${physicalTable}\``)}`,
  )) as unknown as [{ total: number }[]];
  return rows[0]?.total ?? 0;
}

// ─── identity 域检查 ──────────────────────────────────────

/** identity 域一致性检查（User/Role/RolePermission/UserRole → V11）。 */
async function checkIdentityDomain(): Promise<ConsistencyCheck[]> {
  const checks: ConsistencyCheck[] = [];
  const domain: MigrationDomain = "identity";

  // 检查 1：User 表行数 == UserIdentity 表行数
  const userSourceCount = await getSourceCount("User");
  const userIdentityCount = await db.select({ c: count() }).from(userIdentity);
  const uiCount = userIdentityCount[0]?.c ?? 0;
  const uiSkipped = userSourceCount === 0 && uiCount === 0;
  checks.push({
    name: "User → UserIdentity 计数一致",
    domain,
    severity: "blocking",
    passed: uiSkipped || userSourceCount === uiCount,
    expected: userSourceCount,
    actual: uiCount,
    details:
      userSourceCount === uiCount
        ? "源用户数与目标用户身份数一致"
        : `源 User ${userSourceCount} 条，目标 UserIdentity ${uiCount} 条，差异 ${Math.abs(userSourceCount - uiCount)}`,
    skipped: uiSkipped,
  });

  // 检查 2：User 表行数 == PrincipalBinding(subjectType=user) 行数
  const userPbCountRow = await db
    .select({ c: count() })
    .from(principalBinding)
    .where(eq(principalBinding.subjectType, "user"));
  const userPbCount = userPbCountRow[0]?.c ?? 0;
  const userPbSkipped = userSourceCount === 0 && userPbCount === 0;
  checks.push({
    name: "User → PrincipalBinding(user) 计数一致",
    domain,
    severity: "blocking",
    passed: userPbSkipped || userSourceCount === userPbCount,
    expected: userSourceCount,
    actual: userPbCount,
    details:
      userSourceCount === userPbCount
        ? "源用户数与用户主体绑定数一致"
        : `源 User ${userSourceCount} 条，目标 PrincipalBinding(user) ${userPbCount} 条`,
    skipped: userPbSkipped,
  });

  // 检查 3：Role 表行数 == PrincipalBinding(subjectType=role) 行数
  const roleSourceCount = await getSourceCount("Role");
  const rolePbCountRow = await db
    .select({ c: count() })
    .from(principalBinding)
    .where(eq(principalBinding.subjectType, "role"));
  const rolePbCount = rolePbCountRow[0]?.c ?? 0;
  const rolePbSkipped = roleSourceCount === 0 && rolePbCount === 0;
  checks.push({
    name: "Role → PrincipalBinding(role) 计数一致",
    domain,
    severity: "blocking",
    passed: rolePbSkipped || roleSourceCount === rolePbCount,
    expected: roleSourceCount,
    actual: rolePbCount,
    details:
      roleSourceCount === rolePbCount
        ? "源角色数与角色主体绑定数一致"
        : `源 Role ${roleSourceCount} 条，目标 PrincipalBinding(role) ${rolePbCount} 条`,
    skipped: rolePbSkipped,
  });

  // 检查 4：RoleActionBinding 引用完整性——principalBindingId 必须存在
  const [rabOrphanRows] = (await db.execute(sql`
    SELECT COUNT(*) as total
    FROM RoleActionBinding rab
    LEFT JOIN PrincipalBinding pb ON rab.principalBindingId = pb.id
    WHERE pb.id IS NULL
  `)) as unknown as [{ total: number }[]];
  const rabOrphanCount = rabOrphanRows[0]?.total ?? 0;
  const rabTotalRow = await db.select({ c: count() }).from(roleActionBinding);
  const rabTotal = rabTotalRow[0]?.c ?? 0;
  checks.push({
    name: "RoleActionBinding → PrincipalBinding 引用完整",
    domain,
    severity: "blocking",
    passed: rabTotal === 0 || rabOrphanCount === 0,
    expected: 0,
    actual: rabOrphanCount,
    details:
      rabOrphanCount === 0
        ? "无孤儿 RoleActionBinding"
        : `${rabOrphanCount} 条 RoleActionBinding 的 principalBindingId 不存在`,
    skipped: rabTotal === 0,
  });

  // 检查 5：PrincipalBinding(user) 引用完整性——userIdentityId 必须存在
  const [pbOrphanRows] = (await db.execute(sql`
    SELECT COUNT(*) as total
    FROM PrincipalBinding pb
    LEFT JOIN UserIdentity ui ON pb.userIdentityId = ui.id
    WHERE pb.subjectType = 'user' AND pb.userIdentityId IS NOT NULL AND ui.id IS NULL
  `)) as unknown as [{ total: number }[]];
  const pbOrphanCount = pbOrphanRows[0]?.total ?? 0;
  checks.push({
    name: "PrincipalBinding(user) → UserIdentity 引用完整",
    domain,
    severity: "blocking",
    passed: userPbCount === 0 || pbOrphanCount === 0,
    expected: 0,
    actual: pbOrphanCount,
    details:
      pbOrphanCount === 0
        ? "无孤儿 PrincipalBinding(user)"
        : `${pbOrphanCount} 条 PrincipalBinding(user) 的 userIdentityId 不存在`,
    skipped: userPbCount === 0,
  });

  // 检查 6：UserIdentity 租户边界——tenantId 必须存在
  const [uiTenantOrphanRows] = (await db.execute(sql`
    SELECT COUNT(*) as total
    FROM UserIdentity ui
    LEFT JOIN Tenant t ON ui.tenantId = t.id
    WHERE t.id IS NULL
  `)) as unknown as [{ total: number }[]];
  const uiTenantOrphanCount = uiTenantOrphanRows[0]?.total ?? 0;
  checks.push({
    name: "UserIdentity 租户边界完整",
    domain,
    severity: "blocking",
    passed: uiCount === 0 || uiTenantOrphanCount === 0,
    expected: 0,
    actual: uiTenantOrphanCount,
    details:
      uiTenantOrphanCount === 0
        ? "所有 UserIdentity 的 tenantId 有效"
        : `${uiTenantOrphanCount} 条 UserIdentity 的 tenantId 不存在`,
    skipped: uiCount === 0,
  });

  // 检查 7：PrincipalBinding 租户边界——tenantId 必须存在
  const [pbTenantOrphanRows] = (await db.execute(sql`
    SELECT COUNT(*) as total
    FROM PrincipalBinding pb
    LEFT JOIN Tenant t ON pb.tenantId = t.id
    WHERE t.id IS NULL
  `)) as unknown as [{ total: number }[]];
  const pbTenantOrphanCount = pbTenantOrphanRows[0]?.total ?? 0;
  checks.push({
    name: "PrincipalBinding 租户边界完整",
    domain,
    severity: "blocking",
    passed: userPbCount + rolePbCount === 0 || pbTenantOrphanCount === 0,
    expected: 0,
    actual: pbTenantOrphanCount,
    details:
      pbTenantOrphanCount === 0
        ? "所有 PrincipalBinding 的 tenantId 有效"
        : `${pbTenantOrphanCount} 条 PrincipalBinding 的 tenantId 不存在`,
    skipped: userPbCount + rolePbCount === 0,
  });

  // 检查 8：RoleActionBinding 租户边界——tenantId 必须存在
  const [rabTenantOrphanRows] = (await db.execute(sql`
    SELECT COUNT(*) as total
    FROM RoleActionBinding rab
    LEFT JOIN Tenant t ON rab.tenantId = t.id
    WHERE t.id IS NULL
  `)) as unknown as [{ total: number }[]];
  const rabTenantOrphanCount = rabTenantOrphanRows[0]?.total ?? 0;
  checks.push({
    name: "RoleActionBinding 租户边界完整",
    domain,
    severity: "blocking",
    passed: rabTotal === 0 || rabTenantOrphanCount === 0,
    expected: 0,
    actual: rabTenantOrphanCount,
    details:
      rabTenantOrphanCount === 0
        ? "所有 RoleActionBinding 的 tenantId 有效"
        : `${rabTenantOrphanCount} 条 RoleActionBinding 的 tenantId 不存在`,
    skipped: rabTotal === 0,
  });

  return checks;
}

// ─── 迁移状态一致性检查 ──────────────────────────────────

/** 迁移状态与实际数据的一致性检查。 */
async function checkMigrationStateConsistency(
  stateStore: MigrationStateStore,
): Promise<ConsistencyCheck[]> {
  const checks: ConsistencyCheck[] = [];
  const domain: MigrationDomain = "identity";

  // 检查：异常队列是否清零（切换前必须清零）
  const anomalies = stateStore.getAllAnomalies();
  const anomalyCount = anomalies.length;
  // 详情中包含最多 5 条异常原因摘要，便于审阅定位
  const reasonSummary =
    anomalyCount === 0
      ? "无未处理异常"
      : `${anomalyCount} 条异常记录未处理，切换前必须清零或确认入异常队列。摘要: ${anomalies
          .slice(0, 5)
          .map((a) => `[${a.sourceTable}:${a.sourceId}] ${a.reason}`)
          .join("; ")}`;
  checks.push({
    name: "异常队列已清零",
    domain,
    severity: "blocking",
    passed: anomalyCount === 0,
    expected: 0,
    actual: anomalyCount,
    details: reasonSummary,
    skipped: false,
  });

  return checks;
}

// ─── 域检查注册表 ──────────────────────────────────────────

/** 已实现的域检查函数。 */
const DOMAIN_CHECKERS: Partial<Record<MigrationDomain, () => Promise<ConsistencyCheck[]>>> = {
  identity: checkIdentityDomain,
};

/** 生成单域一致性报告。 */
export async function generateDomainConsistencyReport(
  domain: MigrationDomain,
): Promise<DomainConsistencyReport> {
  const checker = DOMAIN_CHECKERS[domain];
  let checks: ConsistencyCheck[] = [];

  if (checker) {
    try {
      checks = await checker();
    } catch {
      // 检查异常时生成失败检查
      checks = [
        {
          name: `${domain} 域检查执行`,
          domain,
          severity: "blocking",
          passed: false,
          expected: 0,
          actual: 0,
          details: `${domain} 域一致性检查执行失败`,
          skipped: false,
        },
      ];
    }
  } else {
    // 未实现的域：生成 info 级跳过检查
    const domainMappings = MAPPING_BASELINE.filter((m) => m.domain === domain);
    checks = domainMappings.map((m) => ({
      name: `${m.legacyTable} 迁移一致性检查`,
      domain,
      severity: "info" as const,
      passed: true,
      expected: 0,
      actual: 0,
      details: `${domain} 域尚未实现迁移转换器，检查自动跳过`,
      skipped: true,
    }));
  }

  const blockingChecks = checks.filter((c) => c.severity === "blocking" && !c.skipped);
  const passedCount = blockingChecks.filter((c) => c.passed).length;
  const failedCount = blockingChecks.filter((c) => !c.passed).length;
  const skippedCount = checks.filter((c) => c.skipped).length;

  return {
    domain,
    checks,
    passed: failedCount === 0,
    passedCount,
    failedCount,
    skippedCount,
  };
}

/** 生成完整一致性核对报告。 */
export async function generateConsistencyReport(
  stateStore?: MigrationStateStore,
): Promise<ConsistencyReport> {
  const domainReports: DomainConsistencyReport[] = [];

  for (const domain of MIGRATION_DOMAINS) {
    const report = await generateDomainConsistencyReport(domain);
    domainReports.push(report);
  }

  // 追加迁移状态一致性检查（独立于域）
  if (stateStore) {
    const stateChecks = await checkMigrationStateConsistency(stateStore);
    if (stateChecks.length > 0) {
      // 归入 identity 域报告（状态检查与 identity 域关联）
      const identityReport = domainReports.find((d) => d.domain === "identity");
      if (identityReport) {
        const allChecks = [...identityReport.checks, ...stateChecks];
        const blockingChecks = allChecks.filter((c) => c.severity === "blocking" && !c.skipped);
        domainReports[domainReports.indexOf(identityReport)] = {
          domain: "identity",
          checks: allChecks,
          passed: blockingChecks.every((c) => c.passed),
          passedCount: blockingChecks.filter((c) => c.passed).length,
          failedCount: blockingChecks.filter((c) => !c.passed).length,
          skippedCount: allChecks.filter((c) => c.skipped).length,
        };
      }
    }
  }

  const allChecks = domainReports.flatMap((d) => d.checks);
  const blockingChecks = allChecks.filter((c) => c.severity === "blocking" && !c.skipped);
  const totalPassed = blockingChecks.filter((c) => c.passed).length;
  const totalFailed = blockingChecks.filter((c) => !c.passed).length;
  const totalSkipped = allChecks.filter((c) => c.skipped).length;

  const blockingIssues: string[] = blockingChecks
    .filter((c) => !c.passed)
    .map((c) => `[${c.domain}] ${c.name}: ${c.details}`);

  return {
    mappingVersion: MAPPING_VERSION,
    generatedAt: new Date().toISOString(),
    domains: domainReports,
    totalChecks: allChecks.length,
    totalPassed,
    totalFailed,
    totalSkipped,
    blockingIssues,
    passed: totalFailed === 0,
  };
}

// ─── 报告格式化 ──────────────────────────────────────────

/** 将一致性报告格式化为可读字符串。 */
export function formatConsistencyReport(report: ConsistencyReport): string {
  const lines: string[] = [
    "V11 迁移一致性核对报告",
    `映射版本: ${report.mappingVersion}`,
    `生成时间: ${report.generatedAt}`,
    "",
    "总计:",
    `  检查数: ${report.totalChecks}`,
    `  通过: ${report.totalPassed}`,
    `  失败: ${report.totalFailed}`,
    `  跳过: ${report.totalSkipped}`,
    `  总体: ${report.passed ? "通过" : "未通过"}`,
    "",
  ];

  if (report.blockingIssues.length > 0) {
    lines.push("阻断性问题:");
    for (const issue of report.blockingIssues) {
      lines.push(`  ! ${issue}`);
    }
    lines.push("");
  }

  lines.push("按域汇总:");
  for (const domain of report.domains) {
    const status = domain.passed ? "通过" : "未通过";
    lines.push(
      `  ${domain.domain}: ${status} (通过 ${domain.passedCount}, 失败 ${domain.failedCount}, 跳过 ${domain.skippedCount})`,
    );
    // 列出失败的 blocking 检查
    for (const check of domain.checks) {
      if (check.severity === "blocking" && !check.skipped && !check.passed) {
        lines.push(`    × ${check.name} (预期 ${check.expected}, 实际 ${check.actual})`);
      }
    }
  }

  return lines.join("\n");
}

// ─── 单表计数便捷工具 ──────────────────────────────────

/** 返回指定 V11 表的行数（identity 域已注册表）。 */
export async function getV11TableRowCount(tableName: string): Promise<number> {
  switch (tableName) {
    case "Tenant": {
      const rows = await db.select({ c: count() }).from(tenant);
      return rows[0]?.c ?? 0;
    }
    case "UserIdentity": {
      const rows = await db.select({ c: count() }).from(userIdentity);
      return rows[0]?.c ?? 0;
    }
    case "PrincipalBinding": {
      const rows = await db.select({ c: count() }).from(principalBinding);
      return rows[0]?.c ?? 0;
    }
    case "RoleActionBinding": {
      const rows = await db.select({ c: count() }).from(roleActionBinding);
      return rows[0]?.c ?? 0;
    }
    default:
      return 0;
  }
}

/** 返回 PrincipalBinding 中指定 subjectType 的行数。 */
export async function getPrincipalBindingCountByType(subjectType: string): Promise<number> {
  const rows = await db
    .select({ c: count() })
    .from(principalBinding)
    .where(
      eq(principalBinding.subjectType, subjectType as "user" | "group" | "role" | "department"),
    );
  return rows[0]?.c ?? 0;
}

/** 返回 RoleActionBinding 中 principalBindingId IS NOT NULL 的行数。 */
export async function getRoleActionBindingWithPrincipalCount(): Promise<number> {
  const rows = await db
    .select({ c: count() })
    .from(roleActionBinding)
    .where(isNotNull(roleActionBinding.principalBindingId));
  return rows[0]?.c ?? 0;
}
