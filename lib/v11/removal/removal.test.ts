import { type CutoverSession, InMemoryCutoverSessionStore } from "@/lib/v11/cutover/session-store";
import { MAPPING_BASELINE } from "@/lib/v11/migration/mapping-baseline";
import {
  ALL_LEGACY_REMOVAL_CATEGORIES,
  type DependencyCheckResult,
  LegacyRemovalError,
  LegacyRemovalGateError,
  type LegacyRemovalItem,
  REMOVAL_CATEGORY_LABELS,
  type RemovalItemStatus,
} from "@/lib/v11/removal/removal-contract";
import {
  LEGACY_WRITE_PATH_OBJECTS,
  WRITE_PATH_KEY_PREFIX,
  generateLegacyTableRemovalItems,
  generateRemovalInventory,
  generateWritePathRemovalItems,
  getRemovalInventoryStats,
  updateItemStatus,
} from "@/lib/v11/removal/removal-inventory";
import {
  type ArchiveProvider,
  type CodeRemovalProvider,
  InMemoryCutoverStabilityChecker,
  LegacyRemovalRunner,
  type ReferenceScannerProvider,
  assertRemovalGate,
  checkDependencies,
  formatRemovalReport,
} from "@/lib/v11/removal/removal-runner";
/**
 * S13-W07 旧路径与兼容层删除集成测试。
 *
 * 覆盖：
 * - 删除契约定义：5 类别 + 状态 + 标签 + 错误类型
 * - 删除清单生成器：写路径 5 项 + 旧表 38 项 + 依赖关系 + 完整清单
 * - 删除执行器：稳定检查 + 依赖排序 + 旧表归档两阶段 + 代码删除 + 异常处理
 * - 全文检索验证：残留引用检测 + 报告生成
 * - 门禁判定：未完成项阻断 + 残留引用阻断 + 断言模式
 */
import { beforeEach, describe, expect, it } from "vitest";

// ═══════════════════════════════════════════════════════════
// 测试夹具：内存 Provider
// ═══════════════════════════════════════════════════════════

/** 内存归档 Provider（测试用）。 */
class InMemoryArchiveProvider implements ArchiveProvider {
  private readonly archivedTables = new Set<string>();
  private readonly verifiedTables = new Set<string>();
  private readonly droppedTables = new Set<string>();
  private failArchive = false;
  private failVerify = false;
  private failDrop = false;

  markArchived(table: string): void {
    this.archivedTables.add(table);
    this.verifiedTables.add(table);
  }

  setFailArchive(fail: boolean): void {
    this.failArchive = fail;
  }

  setFailVerify(fail: boolean): void {
    this.failVerify = fail;
  }

  setFailDrop(fail: boolean): void {
    this.failDrop = fail;
  }

  async archiveTable(item: LegacyRemovalItem): Promise<{ archived: boolean; details: string }> {
    if (this.failArchive) {
      return { archived: false, details: "归档失败（模拟）" };
    }
    this.archivedTables.add(item.physicalTable ?? item.objectName);
    return { archived: true, details: `已归档 ${item.objectName}` };
  }

  async verifyArchiveRestore(
    item: LegacyRemovalItem,
  ): Promise<{ verified: boolean; details: string }> {
    if (this.failVerify) {
      return { verified: false, details: "归档验证失败（模拟）" };
    }
    const table = item.physicalTable ?? item.objectName;
    if (!this.archivedTables.has(table)) {
      return { verified: false, details: "归档副本不存在" };
    }
    this.verifiedTables.add(table);
    return { verified: true, details: `归档验证通过 ${item.objectName}` };
  }

  async dropArchivedTable(item: LegacyRemovalItem): Promise<{ dropped: boolean; details: string }> {
    if (this.failDrop) {
      return { dropped: false, details: "删除失败（模拟）" };
    }
    const table = item.physicalTable ?? item.objectName;
    if (!this.verifiedTables.has(table)) {
      return { dropped: false, details: "未通过归档验证" };
    }
    this.droppedTables.add(table);
    return { dropped: true, details: `已删除 ${item.objectName}` };
  }

  isDropped(table: string): boolean {
    return this.droppedTables.has(table);
  }
}

/** 内存代码删除 Provider（测试用）。 */
class InMemoryCodeRemovalProvider implements CodeRemovalProvider {
  private readonly removedKeys = new Set<string>();
  private failKeys = new Set<string>();

  setFailKeys(keys: string[]): void {
    this.failKeys = new Set(keys);
  }

  isRemoved(key: string): boolean {
    return this.removedKeys.has(key);
  }

  async removeWritePath(item: LegacyRemovalItem): Promise<{ removed: boolean; details: string }> {
    return this.doRemove(item);
  }

  async removeApiRoute(item: LegacyRemovalItem): Promise<{ removed: boolean; details: string }> {
    return this.doRemove(item);
  }

  async removeClientLegacy(
    item: LegacyRemovalItem,
  ): Promise<{ removed: boolean; details: string }> {
    return this.doRemove(item);
  }

  async removeRuntimeEntry(
    item: LegacyRemovalItem,
  ): Promise<{ removed: boolean; details: string }> {
    return this.doRemove(item);
  }

  private async doRemove(item: LegacyRemovalItem): Promise<{ removed: boolean; details: string }> {
    if (this.failKeys.has(item.key)) {
      return { removed: false, details: `删除失败（模拟）：${item.objectName}` };
    }
    this.removedKeys.add(item.key);
    return { removed: true, details: `已删除 ${item.objectName}` };
  }
}

/** 内存引用扫描 Provider（测试用）。 */
class InMemoryReferenceScannerProvider implements ReferenceScannerProvider {
  private readonly referencesMap = new Map<
    string,
    { hasActiveReferences: boolean; references: string[] }
  >();
  private scannedFiles = 100;

  /** 设置某对象的引用扫描结果。 */
  setReferences(objectName: string, references: string[]): void {
    this.referencesMap.set(objectName, {
      hasActiveReferences: references.length > 0,
      references,
    });
  }

  setScannedFiles(count: number): void {
    this.scannedFiles = count;
  }

  async scanReferences(
    objectNames: readonly string[],
  ): Promise<Map<string, { hasActiveReferences: boolean; references: readonly string[] }>> {
    const result = new Map();
    for (const name of objectNames) {
      const existing = this.referencesMap.get(name);
      result.set(name, {
        hasActiveReferences: existing?.hasActiveReferences ?? false,
        references: existing?.references ?? [],
      });
    }
    return result;
  }

  async getScannedFileCount(): Promise<number> {
    return this.scannedFiles;
  }
}

/** 构造全部通过的 Provider 集合。 */
function createPassingProviders() {
  return {
    archive: new InMemoryArchiveProvider(),
    codeRemoval: new InMemoryCodeRemovalProvider(),
    referenceScanner: new InMemoryReferenceScannerProvider(),
    stabilityChecker: new InMemoryCutoverStabilityChecker(),
  };
}

/** 构造已完成的切换会话（cutover_completed + 观察窗口已过）。 */
function createCompletedSession(): { session: CutoverSession; store: InMemoryCutoverSessionStore } {
  const store = new InMemoryCutoverSessionStore();
  const session = store.createSession("operator-1");
  // 标记切换完成（100 小时前，已过默认 72 小时观察窗口）
  const pastTime = new Date(Date.now() - 100 * 60 * 60 * 1000).toISOString();
  const updated = store.updateSession(session.id, {
    state: "cutover_completed",
    completedAt: pastTime,
  });
  return { session: updated, store };
}

// ═══════════════════════════════════════════════════════════
// 1. 删除契约定义
// ═══════════════════════════════════════════════════════════

describe("S13-W07 删除契约定义", () => {
  it("5 个删除类别全部定义", () => {
    expect(ALL_LEGACY_REMOVAL_CATEGORIES).toHaveLength(5);
    expect(ALL_LEGACY_REMOVAL_CATEGORIES).toContain("legacy_write_path");
    expect(ALL_LEGACY_REMOVAL_CATEGORIES).toContain("legacy_api");
    expect(ALL_LEGACY_REMOVAL_CATEGORIES).toContain("legacy_client");
    expect(ALL_LEGACY_REMOVAL_CATEGORIES).toContain("legacy_runtime");
    expect(ALL_LEGACY_REMOVAL_CATEGORIES).toContain("legacy_table");
  });

  it("类别中文标签完整", () => {
    expect(REMOVAL_CATEGORY_LABELS.legacy_write_path).toBe("旧写路径");
    expect(REMOVAL_CATEGORY_LABELS.legacy_table).toBe("旧表归档与删除");
  });

  it("5 个旧写路径对象定义", () => {
    expect(LEGACY_WRITE_PATH_OBJECTS).toHaveLength(5);
    expect(LEGACY_WRITE_PATH_OBJECTS).toContain("Message");
    expect(LEGACY_WRITE_PATH_OBJECTS).toContain("Run");
    expect(LEGACY_WRITE_PATH_OBJECTS).toContain("Transcript");
    expect(LEGACY_WRITE_PATH_OBJECTS).toContain("Subagent");
    expect(LEGACY_WRITE_PATH_OBJECTS).toContain("BackgroundTask");
  });

  it("LegacyRemovalError 携带 itemKey 与 reason", () => {
    const err = new LegacyRemovalError("测试错误", "table:Message", "归档失败");
    expect(err.name).toBe("LegacyRemovalError");
    expect(err.itemKey).toBe("table:Message");
    expect(err.reason).toBe("归档失败");
  });

  it("LegacyRemovalGateError 携带阻断项与报告", () => {
    const fakeReport = {
      generatedAt: "2026-07-23T00:00:00.000Z",
      passed: false,
      blockingItems: ["table:Message"],
      totalItems: 1,
      removedCount: 0,
      archivedCount: 0,
      pendingCount: 1,
      blockedCount: 0,
      categorySummaries: [],
      results: [],
      referenceScan: {
        scannedAt: "2026-07-23T00:00:00.000Z",
        passed: true,
        scannedFiles: 0,
        residualReferences: 0,
        residualByObject: [],
      },
    };
    const err = new LegacyRemovalGateError("门禁失败", ["table:Message"], fakeReport);
    expect(err.name).toBe("LegacyRemovalGateError");
    expect(err.blockingItems).toContain("table:Message");
    expect(err.report).toBe(fakeReport);
  });
});

// ═══════════════════════════════════════════════════════════
// 2. 删除清单生成器
// ═══════════════════════════════════════════════════════════

describe("S13-W07 删除清单生成器", () => {
  it("generateWritePathRemovalItems 生成 5 个写路径删除项", () => {
    const items = generateWritePathRemovalItems();
    expect(items).toHaveLength(5);
    for (const item of items) {
      expect(item.category).toBe("legacy_write_path");
      expect(item.requiresArchive).toBe(false);
      expect(item.status).toBe("pending");
      expect(item.dependsOn).toHaveLength(0);
      expect(item.key).toContain(WRITE_PATH_KEY_PREFIX);
    }
  });

  it("generateLegacyTableRemovalItems 生成 38 张旧表删除项", () => {
    const items = generateLegacyTableRemovalItems();
    expect(items).toHaveLength(38);
    for (const item of items) {
      expect(item.category).toBe("legacy_table");
      expect(item.requiresArchive).toBe(true);
      expect(item.physicalTable).not.toBeNull();
      expect(item.status).toBe("pending");
      expect(item.approvalConditions.length).toBeGreaterThan(0);
    }
  });

  it("Message 表依赖 write_path:Message", () => {
    const items = generateLegacyTableRemovalItems();
    const messageTable = items.find((i) => i.objectName === "Message");
    expect(messageTable?.dependsOn).toContain("write_path:Message");
  });

  it("ThreadRun 表依赖 write_path:Run", () => {
    const items = generateLegacyTableRemovalItems();
    const threadRunTable = items.find((i) => i.objectName === "ThreadRun");
    expect(threadRunTable?.dependsOn).toContain("write_path:Run");
  });

  it("SubagentDefinition 表依赖 write_path:Subagent", () => {
    const items = generateLegacyTableRemovalItems();
    const subagentTable = items.find((i) => i.objectName === "SubagentDefinition");
    expect(subagentTable?.dependsOn).toContain("write_path:Subagent");
  });

  it("BackgroundTask 表依赖 write_path:BackgroundTask", () => {
    const items = generateLegacyTableRemovalItems();
    const taskTable = items.find((i) => i.objectName === "BackgroundTask");
    expect(taskTable?.dependsOn).toContain("write_path:BackgroundTask");
  });

  it("非写路径相关表无写路径依赖", () => {
    const items = generateLegacyTableRemovalItems();
    const userTable = items.find((i) => i.objectName === "User");
    expect(userTable?.dependsOn).toHaveLength(0);
  });

  it("generateRemovalInventory 生成完整清单（写路径 + 旧表 + 自定义）", () => {
    const customApiItem: LegacyRemovalItem = {
      key: "api:/v1/legacy/messages",
      category: "legacy_api",
      objectName: "/v1/legacy/messages",
      physicalTable: null,
      dependsOn: [],
      requiresArchive: false,
      approvalConditions: ["V11 API 已通过验收"],
      status: "pending",
      archivedAt: null,
      removedAt: null,
      blockedReason: null,
    };
    const items = generateRemovalInventory(MAPPING_BASELINE, [customApiItem]);
    // 5 写路径 + 1 自定义 API + 38 旧表 = 44
    expect(items).toHaveLength(44);
    expect(items.filter((i) => i.category === "legacy_write_path")).toHaveLength(5);
    expect(items.filter((i) => i.category === "legacy_api")).toHaveLength(1);
    expect(items.filter((i) => i.category === "legacy_table")).toHaveLength(38);
  });

  it("updateItemStatus 更新状态与时间戳", () => {
    const items = generateWritePathRemovalItems();
    const item = items[0];
    if (!item) throw new Error("测试夹具：写路径项应存在");
    const archived = updateItemStatus(item, "archived");
    expect(archived.status).toBe("archived");
    expect(archived.archivedAt).not.toBeNull();
    expect(archived.removedAt).toBeNull();

    const removed = updateItemStatus(item, "removed");
    expect(removed.status).toBe("removed");
    expect(removed.removedAt).not.toBeNull();
  });

  it("getRemovalInventoryStats 返回正确统计", () => {
    const items = generateRemovalInventory();
    const stats = getRemovalInventoryStats(items);
    expect(stats.totalItems).toBe(43); // 5 写路径 + 38 旧表
    expect(stats.byCategory.legacy_write_path.total).toBe(5);
    expect(stats.byCategory.legacy_table.total).toBe(38);
    expect(stats.byCategory.legacy_write_path.pending).toBe(5);
    expect(stats.byCategory.legacy_table.pending).toBe(38);
  });
});

// ═══════════════════════════════════════════════════════════
// 3. 切换稳定观察窗口检查
// ═══════════════════════════════════════════════════════════

describe("S13-W07 切换稳定观察窗口检查", () => {
  let checker: InMemoryCutoverStabilityChecker;

  beforeEach(() => {
    checker = new InMemoryCutoverStabilityChecker();
  });

  it("无切换会话时检查失败", async () => {
    const result = await checker.checkStability(null);
    expect(result.passed).toBe(false);
    expect(result.reason).toContain("无活跃切换会话");
  });

  it("切换会话非 cutover_completed 时失败", async () => {
    const store = new InMemoryCutoverSessionStore();
    const session = store.createSession("op-1");
    const result = await checker.checkStability(session);
    expect(result.passed).toBe(false);
    expect(result.reason).toContain("非 cutover_completed");
  });

  it("观察窗口未结束时失败", async () => {
    const store = new InMemoryCutoverSessionStore();
    const session = store.createSession("op-1");
    const justNow = new Date().toISOString();
    const updated = store.updateSession(session.id, {
      state: "cutover_completed",
      completedAt: justNow,
    });
    const result = await checker.checkStability(updated);
    expect(result.passed).toBe(false);
    expect(result.reason).toContain("观察窗口未结束");
  });

  it("观察窗口已过时检查通过", async () => {
    const { session } = createCompletedSession();
    const result = await checker.checkStability(session);
    expect(result.passed).toBe(true);
    expect(result.reason).toBeNull();
    expect(result.cutoverCompletedAt).not.toBeNull();
    expect(result.observationWindowEndsAt).not.toBeNull();
  });

  it("可配置观察窗口时长", async () => {
    const store = new InMemoryCutoverSessionStore();
    const session = store.createSession("op-1");
    const oneHourAgo = new Date(Date.now() - 60 * 60 * 1000).toISOString();
    const updated = store.updateSession(session.id, {
      state: "cutover_completed",
      completedAt: oneHourAgo,
    });

    // 默认 72 小时窗口，1 小时前完成 → 未过
    const defaultResult = await checker.checkStability(updated);
    expect(defaultResult.passed).toBe(false);

    // 设置 30 分钟窗口，1 小时前完成 → 已过
    checker.setObservationWindow(30 * 60 * 1000);
    const shortResult = await checker.checkStability(updated);
    expect(shortResult.passed).toBe(true);
  });
});

// ═══════════════════════════════════════════════════════════
// 4. 删除执行器
// ═══════════════════════════════════════════════════════════

describe("S13-W07 删除执行器", () => {
  let providers: ReturnType<typeof createPassingProviders>;
  let session: CutoverSession;

  beforeEach(() => {
    providers = createPassingProviders();
    const completed = createCompletedSession();
    session = completed.session;
  });

  it("稳定检查未通过时全部项标记为 blocked", async () => {
    // 使用未完成的会话
    const store = new InMemoryCutoverSessionStore();
    const pendingSession = store.createSession("op-1");
    const items = generateWritePathRemovalItems();

    const runner = new LegacyRemovalRunner(providers, { operator: "test" });
    const report = await runner.run(items, pendingSession);

    expect(report.passed).toBe(false);
    expect(report.blockedCount).toBe(5);
    expect(report.removedCount).toBe(0);
    for (const item of report.blockingItems) {
      expect(item).toContain("write_path:");
    }
  });

  it("跳过稳定检查时直接执行删除", async () => {
    const items = generateWritePathRemovalItems();
    const runner = new LegacyRemovalRunner(providers, {
      operator: "test",
      skipStabilityCheck: true,
    });
    const report = await runner.run(items, null);

    expect(report.passed).toBe(true);
    expect(report.removedCount).toBe(5);
    expect(report.blockedCount).toBe(0);
  });

  it("旧写路径全部删除成功", async () => {
    const items = generateWritePathRemovalItems();
    const runner = new LegacyRemovalRunner(providers, { operator: "test" });
    const report = await runner.run(items, session);

    expect(report.passed).toBe(true);
    expect(report.removedCount).toBe(5);
    expect(providers.codeRemoval.isRemoved("write_path:Message")).toBe(true);
    expect(providers.codeRemoval.isRemoved("write_path:Run")).toBe(true);
  });

  it("旧表删除走归档两阶段流程", async () => {
    // 仅测试单张表
    const items = generateLegacyTableRemovalItems().filter((i) => i.objectName === "User");
    const runner = new LegacyRemovalRunner(providers, { operator: "test" });
    const report = await runner.run(items, session);

    expect(report.passed).toBe(true);
    expect(report.removedCount).toBe(1);
    // 应有归档和删除两个操作结果
    const tableResults = report.results.filter((r) => r.category === "legacy_table");
    const archiveOp = tableResults.find((r) => r.operation === "archive");
    const removeOp = tableResults.find((r) => r.operation === "remove");
    expect(archiveOp).toBeDefined();
    expect(removeOp).toBeDefined();
    expect(providers.archive.isDropped("User")).toBe(true);
  });

  it("旧表归档失败时标记为 blocked", async () => {
    providers.archive.setFailArchive(true);
    const items = generateLegacyTableRemovalItems().filter((i) => i.objectName === "User");
    const runner = new LegacyRemovalRunner(providers, { operator: "test" });
    const report = await runner.run(items, session);

    expect(report.passed).toBe(false);
    expect(report.blockedCount).toBe(1);
    const userResult = report.results.find((r) => r.key === "table:User");
    expect(userResult?.success).toBe(false);
    expect(userResult?.details).toContain("归档失败");
  });

  it("旧表归档验证失败时标记为 blocked", async () => {
    providers.archive.setFailVerify(true);
    const items = generateLegacyTableRemovalItems().filter((i) => i.objectName === "User");
    const runner = new LegacyRemovalRunner(providers, { operator: "test" });
    const report = await runner.run(items, session);

    expect(report.passed).toBe(false);
    expect(report.blockedCount).toBe(1);
    const userResult = report.results.find((r) => r.key === "table:User");
    expect(userResult?.success).toBe(false);
    expect(userResult?.details).toContain("归档验证失败");
  });

  it("旧表删除失败时标记为 blocked", async () => {
    providers.archive.setFailDrop(true);
    const items = generateLegacyTableRemovalItems().filter((i) => i.objectName === "User");
    const runner = new LegacyRemovalRunner(providers, { operator: "test" });
    const report = await runner.run(items, session);

    expect(report.passed).toBe(false);
    expect(report.blockedCount).toBe(1);
    const userResult = report.results.find((r) => r.key === "table:User");
    expect(userResult?.success).toBe(false);
    expect(userResult?.details).toContain("删除失败");
  });

  it("代码删除失败时标记为 blocked", async () => {
    providers.codeRemoval.setFailKeys(["write_path:Message"]);
    const items = generateWritePathRemovalItems();
    const runner = new LegacyRemovalRunner(providers, { operator: "test" });
    const report = await runner.run(items, session);

    expect(report.passed).toBe(false);
    expect(report.removedCount).toBe(4);
    expect(report.blockedCount).toBe(1);
    expect(report.blockingItems).toContain("write_path:Message");
  });

  it("依赖项未完成时阻断后续删除", async () => {
    // Message 表依赖 write_path:Message，让写路径删除失败
    providers.codeRemoval.setFailKeys(["write_path:Message"]);
    const items = [
      ...generateWritePathRemovalItems(),
      ...generateLegacyTableRemovalItems().filter((i) => i.objectName === "Message"),
    ];
    const runner = new LegacyRemovalRunner(providers, { operator: "test" });
    const report = await runner.run(items, session);

    expect(report.passed).toBe(false);
    // write_path:Message 阻断 → table:Message 也被阻断
    const tableResult = report.results.find((r) => r.key === "table:Message");
    expect(tableResult?.success).toBe(false);
    expect(tableResult?.details).toContain("依赖项未完成");
  });

  it("完整清单（写路径 + 旧表）全部删除成功", async () => {
    const items = generateRemovalInventory();
    const runner = new LegacyRemovalRunner(providers, { operator: "test" });
    const report = await runner.run(items, session);

    expect(report.passed).toBe(true);
    expect(report.removedCount).toBe(43);
    expect(report.blockedCount).toBe(0);
    expect(report.referenceScan.passed).toBe(true);
  });
});

// ═══════════════════════════════════════════════════════════
// 5. 全文检索验证
// ═══════════════════════════════════════════════════════════

describe("S13-W07 全文检索验证", () => {
  let providers: ReturnType<typeof createPassingProviders>;

  beforeEach(() => {
    providers = createPassingProviders();
  });

  it("无残留引用时验证通过", async () => {
    const items = generateWritePathRemovalItems();
    const runner = new LegacyRemovalRunner(providers, {
      operator: "test",
      skipStabilityCheck: true,
    });
    const report = await runner.run(items, null);

    expect(report.referenceScan.passed).toBe(true);
    expect(report.referenceScan.residualReferences).toBe(0);
    expect(report.referenceScan.scannedFiles).toBe(100);
  });

  it("有残留引用时验证失败", async () => {
    providers.referenceScanner.setReferences("Message", [
      "lib/legacy/messages.ts:42",
      "app/api/legacy/messages/route.ts:15",
    ]);
    const items = generateWritePathRemovalItems();
    const runner = new LegacyRemovalRunner(providers, {
      operator: "test",
      skipStabilityCheck: true,
    });
    const report = await runner.run(items, null);

    expect(report.referenceScan.passed).toBe(false);
    expect(report.referenceScan.residualReferences).toBe(2);
    expect(report.referenceScan.residualByObject).toHaveLength(1);
    expect(report.referenceScan.residualByObject[0]?.objectName).toBe("Message");
    expect(report.referenceScan.residualByObject[0]?.count).toBe(2);
  });

  it("残留引用导致总体报告失败", async () => {
    providers.referenceScanner.setReferences("Run", ["lib/legacy/run.ts:10"]);
    const items = generateWritePathRemovalItems();
    const runner = new LegacyRemovalRunner(providers, {
      operator: "test",
      skipStabilityCheck: true,
    });
    const report = await runner.run(items, null);

    // 全部删除成功，但残留引用存在
    expect(report.removedCount).toBe(5);
    expect(report.referenceScan.passed).toBe(false);
    expect(report.passed).toBe(false);
  });

  it("checkDependencies 批量检查依赖", async () => {
    const items = generateWritePathRemovalItems();
    providers.referenceScanner.setReferences("Message", ["lib/legacy.ts:1"]);
    const result = await checkDependencies(items, providers.referenceScanner);

    expect(result.size).toBe(5);
    const messageCheck = result.get("write_path:Message");
    expect(messageCheck?.hasActiveReferences).toBe(true);
    expect(messageCheck?.references).toContain("lib/legacy.ts:1");

    const runCheck = result.get("write_path:Run");
    expect(runCheck?.hasActiveReferences).toBe(false);
    expect(runCheck?.references).toHaveLength(0);
  });
});

// ═══════════════════════════════════════════════════════════
// 6. 报告生成与门禁
// ═══════════════════════════════════════════════════════════

describe("S13-W07 报告生成与门禁", () => {
  let providers: ReturnType<typeof createPassingProviders>;
  let session: CutoverSession;

  beforeEach(() => {
    providers = createPassingProviders();
    const completed = createCompletedSession();
    session = completed.session;
  });

  it("按类别汇总正确", async () => {
    const items = generateRemovalInventory();
    const runner = new LegacyRemovalRunner(providers, { operator: "test" });
    const report = await runner.run(items, session);

    const writePathSummary = report.categorySummaries.find(
      (c) => c.category === "legacy_write_path",
    );
    expect(writePathSummary?.total).toBe(5);
    expect(writePathSummary?.removed).toBe(5);

    const tableSummary = report.categorySummaries.find((c) => c.category === "legacy_table");
    expect(tableSummary?.total).toBe(38);
    expect(tableSummary?.removed).toBe(38);
  });

  it("formatRemovalReport 生成可读字符串", async () => {
    const items = generateWritePathRemovalItems();
    const runner = new LegacyRemovalRunner(providers, { operator: "test" });
    const report = await runner.run(items, session);
    const text = formatRemovalReport(report);

    expect(text).toContain("V11 旧路径删除报告");
    expect(text).toContain("总体结果：PASSED");
    expect(text).toContain("删除项：5");
    expect(text).toContain("按类别汇总");
    expect(text).toContain("全文检索验证");
    expect(text).toContain("legacy_write_path");
  });

  it("formatRemovalReport 失败时显示未完成项与残留引用", async () => {
    providers.codeRemoval.setFailKeys(["write_path:Message"]);
    providers.referenceScanner.setReferences("Message", ["lib/legacy.ts:1"]);
    const items = generateWritePathRemovalItems();
    const runner = new LegacyRemovalRunner(providers, { operator: "test" });
    const report = await runner.run(items, session);
    const text = formatRemovalReport(report);

    expect(text).toContain("总体结果：FAILED");
    expect(text).toContain("未完成项清单");
    expect(text).toContain("write_path:Message");
    expect(text).toContain("残留引用详情");
    expect(text).toContain("Message: 1 处");
  });

  it("assertRemovalGate 全部通过时不抛错", async () => {
    const items = generateWritePathRemovalItems();
    const runner = new LegacyRemovalRunner(providers, { operator: "test" });
    const report = await runner.run(items, session);
    expect(() => assertRemovalGate(report)).not.toThrow();
  });

  it("assertRemovalGate 失败时抛 LegacyRemovalGateError", async () => {
    providers.codeRemoval.setFailKeys(["write_path:Message"]);
    const items = generateWritePathRemovalItems();
    const runner = new LegacyRemovalRunner(providers, { operator: "test" });
    const report = await runner.run(items, session);

    try {
      assertRemovalGate(report);
      expect.unreachable("应抛 LegacyRemovalGateError");
    } catch (err) {
      expect(err).toBeInstanceOf(LegacyRemovalGateError);
      expect((err as LegacyRemovalGateError).blockingItems).toContain("write_path:Message");
      expect((err as LegacyRemovalGateError).message).toContain("旧路径删除门禁失败");
    }
  });

  it("残留引用导致门禁失败", async () => {
    providers.referenceScanner.setReferences("Message", ["lib/legacy.ts:1"]);
    const items = generateWritePathRemovalItems();
    const runner = new LegacyRemovalRunner(providers, { operator: "test" });
    const report = await runner.run(items, session);

    expect(report.removedCount).toBe(5);
    expect(report.referenceScan.passed).toBe(false);
    expect(report.passed).toBe(false);

    try {
      assertRemovalGate(report);
      expect.unreachable("应抛 LegacyRemovalGateError");
    } catch (err) {
      expect(err).toBeInstanceOf(LegacyRemovalGateError);
      expect((err as LegacyRemovalGateError).message).toContain("残留引用");
    }
  });
});

// ═══════════════════════════════════════════════════════════
// 7. 旧表归档两阶段流程
// ═══════════════════════════════════════════════════════════

describe("S13-W07 旧表归档两阶段流程", () => {
  let providers: ReturnType<typeof createPassingProviders>;
  let session: CutoverSession;

  beforeEach(() => {
    providers = createPassingProviders();
    const completed = createCompletedSession();
    session = completed.session;
  });

  it("归档阶段产出 archive 操作结果", async () => {
    const items = generateLegacyTableRemovalItems().slice(0, 3);
    const runner = new LegacyRemovalRunner(providers, { operator: "test" });
    const report = await runner.run(items, session);

    const archiveOps = report.results.filter((r) => r.operation === "archive");
    expect(archiveOps).toHaveLength(3);
    for (const op of archiveOps) {
      expect(op.success).toBe(true);
      expect(op.details).toContain("已归档");
    }
  });

  it("删除阶段产出 remove 操作结果", async () => {
    const items = generateLegacyTableRemovalItems().slice(0, 3);
    const runner = new LegacyRemovalRunner(providers, { operator: "test" });
    const report = await runner.run(items, session);

    const removeOps = report.results.filter(
      (r) => r.operation === "remove" && r.category === "legacy_table",
    );
    expect(removeOps).toHaveLength(3);
    for (const op of removeOps) {
      expect(op.success).toBe(true);
      expect(op.details).toContain("已删除");
    }
  });

  it("归档后表已停止读写（通过 isDropped 验证最终删除）", async () => {
    const items = generateLegacyTableRemovalItems().filter((i) => i.objectName === "User");
    const runner = new LegacyRemovalRunner(providers, { operator: "test" });
    await runner.run(items, session);

    expect(providers.archive.isDropped("User")).toBe(true);
  });

  it("多张旧表批量归档与删除", async () => {
    const items = generateLegacyTableRemovalItems().slice(0, 10);
    const runner = new LegacyRemovalRunner(providers, { operator: "test" });
    const report = await runner.run(items, session);

    expect(report.passed).toBe(true);
    expect(report.removedCount).toBe(10);
    for (const item of items) {
      expect(providers.archive.isDropped(item.physicalTable ?? item.objectName)).toBe(true);
    }
  });
});
