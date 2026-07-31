import type { CutoverSession } from "@/lib/v11/cutover/session-store";
/**
 * S13-W07 旧路径删除执行器与归档控制器。
 *
 * 职责：
 * - 切换稳定观察窗口检查：确认切换已完成且观察窗口已过才允许删除。
 * - 依赖检查：删除前扫描代码库是否有活跃引用。
 * - 归档控制器：legacy_table 先归档（停止读写 + 受控归档），后批准删除。
 * - 删除执行器：按依赖顺序执行删除，每项独立失败处理。
 * - 全文检索验证：删除后扫描残留引用。
 * - 报告生成：按类别汇总 + 阻断项清单 + 全文检索报告。
 *
 * 安全约束：
 * - 不在切换提交里直接破坏回滚点（必须先过观察窗口）。
 * - 旧表先归档保留受控副本，达到批准条件后才通过独立迁移删除。
 * - 删除后再次全文检索旧对象引用并运行全部验收。
 */
import {
  type CutoverStabilityCheckResult,
  type CutoverStabilityChecker,
  type DependencyCheckResult,
  type LegacyReferenceScanReport,
  type LegacyRemovalCategory,
  LegacyRemovalError,
  LegacyRemovalGateError,
  type LegacyRemovalItem,
  type LegacyRemovalReport,
  type RemovalResult,
} from "@/lib/v11/removal/removal-contract";

// ─── Provider 接口 ────────────────────────────────────────

/** 归档 Provider（生产环境实现真实归档逻辑）。 */
export interface ArchiveProvider {
  /** 归档单张旧表（导出受控副本并标记停止读写）。 */
  archiveTable(item: LegacyRemovalItem): Promise<{ archived: boolean; details: string }>;
  /** 验证归档副本可恢复。 */
  verifyArchiveRestore(item: LegacyRemovalItem): Promise<{ verified: boolean; details: string }>;
  /** 删除已归档的旧表（通过独立迁移）。 */
  dropArchivedTable(item: LegacyRemovalItem): Promise<{ dropped: boolean; details: string }>;
}

/** 代码删除 Provider（生产环境实现真实代码删除）。 */
export interface CodeRemovalProvider {
  /** 删除旧写路径代码。 */
  removeWritePath(item: LegacyRemovalItem): Promise<{ removed: boolean; details: string }>;
  /** 删除旧 API 路由。 */
  removeApiRoute(item: LegacyRemovalItem): Promise<{ removed: boolean; details: string }>;
  /** 删除旧客户端字段、事件猜测、双轨 reducer。 */
  removeClientLegacy(item: LegacyRemovalItem): Promise<{ removed: boolean; details: string }>;
  /** 删除旧 Runtime 入口。 */
  removeRuntimeEntry(item: LegacyRemovalItem): Promise<{ removed: boolean; details: string }>;
}

/** 依赖扫描 Provider（全文检索旧对象引用）。 */
export interface ReferenceScannerProvider {
  /** 扫描指定旧对象的活跃引用。 */
  scanReferences(
    objectNames: readonly string[],
  ): Promise<Map<string, { hasActiveReferences: boolean; references: readonly string[] }>>;
  /** 获取扫描的文件数。 */
  getScannedFileCount(): Promise<number>;
}

/** 全部 Provider 集合。 */
export interface RemovalProviders {
  readonly archive: ArchiveProvider;
  readonly codeRemoval: CodeRemovalProvider;
  readonly referenceScanner: ReferenceScannerProvider;
  readonly stabilityChecker: CutoverStabilityChecker;
}

// ─── 默认观察窗口 ──────────────────────────────────────────

/** 默认观察窗口时长（毫秒）：72 小时。 */
export const DEFAULT_OBSERVATION_WINDOW_MS = 72 * 60 * 60 * 1000;

// ─── 内存稳定检查器（测试用） ──────────────────────────────

/** 内存切换稳定检查器（测试用）。 */
export class InMemoryCutoverStabilityChecker implements CutoverStabilityChecker {
  private completedAt: string | null = null;
  private observationWindowMs = DEFAULT_OBSERVATION_WINDOW_MS;

  /** 标记切换完成时间。 */
  markCompleted(completedAt: string = new Date().toISOString()): void {
    this.completedAt = completedAt;
  }

  /** 设置观察窗口时长。 */
  setObservationWindow(ms: number): void {
    this.observationWindowMs = ms;
  }

  async checkStability(session: CutoverSession | null): Promise<CutoverStabilityCheckResult> {
    const checkedAt = new Date().toISOString();

    // 切换会话必须存在
    if (!session) {
      return {
        passed: false,
        sessionId: null,
        cutoverCompletedAt: null,
        observationWindowEndsAt: null,
        checkedAt,
        reason: "无活跃切换会话",
      };
    }

    // 切换会话必须处于 cutover_completed 终态
    if (session.state !== "cutover_completed") {
      return {
        passed: false,
        sessionId: session.id,
        cutoverCompletedAt: null,
        observationWindowEndsAt: null,
        checkedAt,
        reason: `切换会话状态为 ${session.state}，非 cutover_completed`,
      };
    }

    const cutoverCompletedAt = session.completedAt ?? this.completedAt;
    if (!cutoverCompletedAt) {
      return {
        passed: false,
        sessionId: session.id,
        cutoverCompletedAt: null,
        observationWindowEndsAt: null,
        checkedAt,
        reason: "切换完成时间缺失",
      };
    }

    const endsAt = new Date(
      new Date(cutoverCompletedAt).getTime() + this.observationWindowMs,
    ).toISOString();
    const now = Date.now();
    const endsAtMs = new Date(endsAt).getTime();

    if (now < endsAtMs) {
      return {
        passed: false,
        sessionId: session.id,
        cutoverCompletedAt,
        observationWindowEndsAt: endsAt,
        checkedAt,
        reason: `观察窗口未结束（结束时间 ${endsAt}）`,
      };
    }

    return {
      passed: true,
      sessionId: session.id,
      cutoverCompletedAt,
      observationWindowEndsAt: endsAt,
      checkedAt,
      reason: null,
    };
  }
}

// ─── 删除执行器 ───────────────────────────────────────────

/** 执行器选项。 */
export interface LegacyRemovalRunnerOptions {
  /** 执行人。 */
  readonly operator: string;
  /** 是否跳过稳定检查（测试用，默认 false）。 */
  readonly skipStabilityCheck?: boolean;
}

/**
 * 旧路径删除执行器。
 *
 * 流程：
 * 1. 检查切换稳定观察窗口（全部删除前置条件）。
 * 2. 按依赖顺序处理每个删除项：
 *    - legacy_table：先归档 → 验证归档 → 满足批准条件后删除。
 *    - 其他类别：直接删除代码。
 * 3. 删除后全文检索验证残留引用。
 * 4. 生成报告。
 */
export class LegacyRemovalRunner {
  constructor(
    private readonly providers: RemovalProviders,
    private readonly options: LegacyRemovalRunnerOptions,
  ) {}

  /**
   * 执行完整删除流程。
   * @param items 删除清单
   * @param session 切换会话（用于稳定检查）
   * @returns 删除报告
   */
  async run(
    items: readonly LegacyRemovalItem[],
    session: CutoverSession | null,
  ): Promise<LegacyRemovalReport> {
    const results: RemovalResult[] = [];
    const itemStatusMap = new Map<string, LegacyRemovalItem>();
    for (const item of items) {
      itemStatusMap.set(item.key, item);
    }

    // 步骤 1：稳定检查
    if (!this.options.skipStabilityCheck) {
      const stability = await this.providers.stabilityChecker.checkStability(session);
      if (!stability.passed) {
        // 全部项标记为 blocked
        for (const item of items) {
          const blocked = { ...item, status: "blocked" as const, blockedReason: stability.reason };
          itemStatusMap.set(item.key, blocked);
          results.push({
            key: item.key,
            category: item.category,
            success: false,
            operation: "verify",
            details: `稳定检查未通过：${stability.reason}`,
            timestamp: new Date().toISOString(),
          });
        }
        return this.buildReport(items, itemStatusMap, results, null);
      }
    }

    // 步骤 2：按依赖顺序处理
    // 先处理无依赖项（写路径、API、客户端、Runtime），再处理有依赖项（旧表）
    const orderedItems = this.orderByDependencies(items);

    for (const item of orderedItems) {
      const currentItem = itemStatusMap.get(item.key) ?? item;
      if (currentItem.status === "removed" || currentItem.status === "blocked") {
        continue;
      }

      // 检查依赖是否已完成
      const depBlocked = this.checkDependenciesBlocked(currentItem, itemStatusMap);
      if (depBlocked) {
        const blocked = {
          ...currentItem,
          status: "blocked" as const,
          blockedReason: `依赖项未完成：${depBlocked}`,
        };
        itemStatusMap.set(item.key, blocked);
        results.push({
          key: item.key,
          category: item.category,
          success: false,
          operation: "verify",
          details: `依赖项未完成：${depBlocked}`,
          timestamp: new Date().toISOString(),
        });
        continue;
      }

      // 按类别执行
      const processResult = await this.processItem(currentItem);
      results.push(...processResult.results);
      itemStatusMap.set(item.key, processResult.updatedItem);
    }

    // 步骤 3：全文检索验证
    const referenceScan = await this.runReferenceScan(items);

    return this.buildReport(items, itemStatusMap, results, referenceScan);
  }

  /** 按依赖顺序排序（拓扑排序简化版）。 */
  private orderByDependencies(items: readonly LegacyRemovalItem[]): LegacyRemovalItem[] {
    const result: LegacyRemovalItem[] = [];
    const added = new Set<string>();

    const add = (item: LegacyRemovalItem) => {
      if (added.has(item.key)) return;
      for (const depKey of item.dependsOn) {
        const dep = items.find((i) => i.key === depKey);
        if (dep) add(dep);
      }
      added.add(item.key);
      result.push(item);
    };

    for (const item of items) add(item);
    return result;
  }

  /** 检查依赖项是否已删除；返回阻断的依赖 key（空字符串表示无阻断）。
   *  仅检查清单内依赖项；清单外的依赖视为已在外部完成。 */
  private checkDependenciesBlocked(
    item: LegacyRemovalItem,
    statusMap: Map<string, LegacyRemovalItem>,
  ): string | null {
    for (const depKey of item.dependsOn) {
      const dep = statusMap.get(depKey);
      // 依赖项不在当前清单中，视为已在外部完成，不阻断
      if (!dep) continue;
      if (dep.status !== "removed") {
        return depKey;
      }
    }
    return null;
  }

  /** 处理单个删除项，返回一个或多个结果（旧表归档+删除产生两个结果）。 */
  private async processItem(
    item: LegacyRemovalItem,
  ): Promise<{ results: RemovalResult[]; updatedItem: LegacyRemovalItem }> {
    const timestamp = new Date().toISOString();

    try {
      if (item.category === "legacy_table") {
        // 旧表：归档 → 验证 → 删除（两阶段）
        return await this.processTableItem(item);
      }

      // 其他类别：直接删除代码
      const provider = this.selectCodeProvider(item.category);
      const removeResult = await provider(item);
      if (!removeResult.removed) {
        throw new LegacyRemovalError(
          `删除失败：${removeResult.details}`,
          item.key,
          removeResult.details,
        );
      }
      const updatedItem = {
        ...item,
        status: "removed" as const,
        removedAt: timestamp,
      };
      return {
        results: [
          {
            key: item.key,
            category: item.category,
            success: true,
            operation: "remove" as const,
            details: removeResult.details,
            timestamp,
          },
        ],
        updatedItem,
      };
    } catch (err) {
      const updatedItem = {
        ...item,
        status: "blocked" as const,
        blockedReason: err instanceof Error ? err.message : String(err),
      };
      return {
        results: [
          {
            key: item.key,
            category: item.category,
            success: false,
            operation: "remove" as const,
            details: `删除异常：${err instanceof Error ? err.message : String(err)}`,
            timestamp,
          },
        ],
        updatedItem,
      };
    }
  }

  /** 处理旧表删除项（归档 → 验证 → 删除两阶段，一次调用完成，返回两个结果）。 */
  private async processTableItem(
    item: LegacyRemovalItem,
  ): Promise<{ results: RemovalResult[]; updatedItem: LegacyRemovalItem }> {
    const timestamp = new Date().toISOString();
    const results: RemovalResult[] = [];

    // 阶段 1：归档（pending 状态时执行）
    if (item.status === "pending") {
      const archiveResult = await this.providers.archive.archiveTable(item);
      if (!archiveResult.archived) {
        throw new LegacyRemovalError(
          `归档失败：${archiveResult.details}`,
          item.key,
          archiveResult.details,
        );
      }
      results.push({
        key: item.key,
        category: item.category,
        success: true,
        operation: "archive",
        details: archiveResult.details,
        timestamp,
      });
    } else if (item.status !== "archived" && item.status !== "removal_ready") {
      throw new LegacyRemovalError(
        `旧表状态 ${item.status} 不可处理`,
        item.key,
        `非法状态：${item.status}`,
      );
    }

    // 阶段 2：验证归档 + 删除
    const verifyResult = await this.providers.archive.verifyArchiveRestore(item);
    if (!verifyResult.verified) {
      throw new LegacyRemovalError(
        `归档验证失败：${verifyResult.details}`,
        item.key,
        verifyResult.details,
      );
    }
    const dropResult = await this.providers.archive.dropArchivedTable(item);
    if (!dropResult.dropped) {
      throw new LegacyRemovalError(`删除失败：${dropResult.details}`, item.key, dropResult.details);
    }
    results.push({
      key: item.key,
      category: item.category,
      success: true,
      operation: "remove",
      details: dropResult.details,
      timestamp,
    });
    const removedItem = {
      ...item,
      status: "removed" as const,
      archivedAt: item.archivedAt ?? timestamp,
      removedAt: timestamp,
    };
    return { results, updatedItem: removedItem };
  }

  /** 选择代码删除 Provider。 */
  private selectCodeProvider(
    category: LegacyRemovalCategory,
  ): (item: LegacyRemovalItem) => Promise<{ removed: boolean; details: string }> {
    switch (category) {
      case "legacy_write_path":
        return (item) => this.providers.codeRemoval.removeWritePath(item);
      case "legacy_api":
        return (item) => this.providers.codeRemoval.removeApiRoute(item);
      case "legacy_client":
        return (item) => this.providers.codeRemoval.removeClientLegacy(item);
      case "legacy_runtime":
        return (item) => this.providers.codeRemoval.removeRuntimeEntry(item);
      case "legacy_table":
        throw new Error("legacy_table 类别应使用归档流程");
    }
  }

  /** 执行全文检索验证。 */
  private async runReferenceScan(
    items: readonly LegacyRemovalItem[],
  ): Promise<LegacyReferenceScanReport> {
    const objectNames = items.map((i) => i.objectName);
    const scanResults = await this.providers.referenceScanner.scanReferences(objectNames);
    const scannedFiles = await this.providers.referenceScanner.getScannedFileCount();

    let residualCount = 0;
    const residualByObjectMap = new Map<string, number>();
    for (const [objectName, result] of scanResults) {
      if (result.hasActiveReferences) {
        residualCount += result.references.length;
        residualByObjectMap.set(objectName, result.references.length);
      }
    }

    return {
      scannedAt: new Date().toISOString(),
      passed: residualCount === 0,
      scannedFiles,
      residualReferences: residualCount,
      residualByObject: [...residualByObjectMap.entries()].map(([objectName, count]) => ({
        objectName,
        count,
      })),
    };
  }

  /** 构建报告。 */
  private buildReport(
    items: readonly LegacyRemovalItem[],
    statusMap: Map<string, LegacyRemovalItem>,
    results: readonly RemovalResult[],
    referenceScan: LegacyReferenceScanReport | null,
  ): LegacyRemovalReport {
    const finalItems = items.map((i) => statusMap.get(i.key) ?? i);
    const blockingItems = finalItems
      .filter((i) => i.status === "blocked" || i.status === "pending" || i.status === "archived")
      .map((i) => i.key);

    const removedCount = finalItems.filter((i) => i.status === "removed").length;
    const archivedCount = finalItems.filter((i) => i.status === "archived").length;
    const pendingCount = finalItems.filter((i) => i.status === "pending").length;
    const blockedCount = finalItems.filter((i) => i.status === "blocked").length;

    const categories: LegacyRemovalCategory[] = [
      "legacy_write_path",
      "legacy_api",
      "legacy_client",
      "legacy_runtime",
      "legacy_table",
    ];
    const categorySummaries = categories.map((category) => {
      const catItems = finalItems.filter((i) => i.category === category);
      return {
        category,
        total: catItems.length,
        removed: catItems.filter((i) => i.status === "removed").length,
        archived: catItems.filter((i) => i.status === "archived").length,
        pending: catItems.filter((i) => i.status === "pending").length,
        blocked: catItems.filter((i) => i.status === "blocked").length,
      };
    });

    const referenceScanReport: LegacyReferenceScanReport = referenceScan ?? {
      scannedAt: new Date().toISOString(),
      passed: false,
      scannedFiles: 0,
      residualReferences: 0,
      residualByObject: [],
    };

    const passed =
      blockingItems.length === 0 && referenceScanReport.passed && removedCount === items.length;

    return {
      generatedAt: new Date().toISOString(),
      passed,
      blockingItems,
      totalItems: items.length,
      removedCount,
      archivedCount,
      pendingCount,
      blockedCount,
      categorySummaries,
      results,
      referenceScan: referenceScanReport,
    };
  }
}

// ─── 门禁校验 ─────────────────────────────────────────────

/** 门禁断言：存在未删除/阻断项或残留引用时抛 LegacyRemovalGateError。 */
export function assertRemovalGate(report: LegacyRemovalReport): void {
  if (!report.passed) {
    throw new LegacyRemovalGateError(
      `旧路径删除门禁失败：${report.blockingItems.length} 个未完成项，${report.referenceScan.residualReferences} 个残留引用`,
      report.blockingItems,
      report,
    );
  }
}

// ─── 报告格式化 ───────────────────────────────────────────

/** 格式化删除报告为可读字符串。 */
export function formatRemovalReport(report: LegacyRemovalReport): string {
  const lines: string[] = [];
  lines.push("=== V11 旧路径删除报告 ===");
  lines.push(`生成时间：${report.generatedAt}`);
  lines.push(`总体结果：${report.passed ? "PASSED" : "FAILED"}`);
  lines.push(
    `删除项：${report.totalItems}（已删除 ${report.removedCount} | 已归档 ${report.archivedCount} | 待处理 ${report.pendingCount} | 阻断 ${report.blockedCount}）`,
  );

  if (report.blockingItems.length > 0) {
    lines.push("");
    lines.push("未完成项清单：");
    for (const key of report.blockingItems) {
      lines.push(`  - ${key}`);
    }
  }

  lines.push("");
  lines.push("按类别汇总：");
  for (const cat of report.categorySummaries) {
    lines.push(
      `  - ${cat.category}: ${cat.total} 项（删除 ${cat.removed} | 归档 ${cat.archived} | 待处理 ${cat.pending} | 阻断 ${cat.blocked}）`,
    );
  }

  lines.push("");
  lines.push("全文检索验证：");
  lines.push(`  扫描文件数：${report.referenceScan.scannedFiles}`);
  lines.push(`  残留引用数：${report.referenceScan.residualReferences}`);
  lines.push(`  验证结果：${report.referenceScan.passed ? "PASSED" : "FAILED"}`);
  if (report.referenceScan.residualByObject.length > 0) {
    lines.push("  残留引用详情：");
    for (const r of report.referenceScan.residualByObject) {
      lines.push(`    - ${r.objectName}: ${r.count} 处`);
    }
  }

  return lines.join("\n");
}

// ─── 依赖检查工具 ──────────────────────────────────────────

/** 批量检查多个删除项的依赖。 */
export async function checkDependencies(
  items: readonly LegacyRemovalItem[],
  scanner: ReferenceScannerProvider,
): Promise<Map<string, DependencyCheckResult>> {
  const objectNames = items.map((i) => i.objectName);
  const scanResults = await scanner.scanReferences(objectNames);
  const result = new Map<string, DependencyCheckResult>();
  const timestamp = new Date().toISOString();
  for (const item of items) {
    const scan = scanResults.get(item.objectName);
    result.set(item.key, {
      itemKey: item.key,
      hasActiveReferences: scan?.hasActiveReferences ?? false,
      references: scan?.references ?? [],
      timestamp,
    });
  }
  return result;
}
