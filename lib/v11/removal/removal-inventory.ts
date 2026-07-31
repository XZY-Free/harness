import { type LegacyTableMapping, MAPPING_BASELINE } from "@/lib/v11/migration/mapping-baseline";
/**
 * S13-W07 删除清单生成器。
 *
 * 职责：
 * - 从迁移映射基线生成 legacy_table 类别的删除项（38 张旧表）。
 * - 提供标准旧写路径、旧 API、旧客户端、旧 Runtime 删除项模板。
 * - 支持自定义删除项（生产环境补充具体路径/字段）。
 *
 * 设计：
 * - 生成器为纯函数，输入映射基线，输出删除项列表。
 * - legacy_table 删除项的 dependsOn 自动设置为对应的写路径删除项。
 * - 物理表名来自映射基线，便于归档与删除时定位。
 */
import type {
  LegacyRemovalCategory,
  LegacyRemovalItem,
  RemovalItemStatus,
} from "@/lib/v11/removal/removal-contract";

// ─── 标准旧写路径删除项 ────────────────────────────────────

/**
 * S13-W07 要求删除的 5 类旧写路径对象。
 *
 * 来自阶段计划："删除旧 Message/Run/Transcript/Subagent/BackgroundTask 写路径"。
 */
export const LEGACY_WRITE_PATH_OBJECTS = [
  "Message",
  "Run",
  "Transcript",
  "Subagent",
  "BackgroundTask",
] as const;

/** 旧写路径删除项 key 前缀。 */
export const WRITE_PATH_KEY_PREFIX = "write_path:";

// ─── 标准旧表删除项生成 ────────────────────────────────────

/**
 * 从映射基线生成 legacy_table 删除项。
 *
 * 每张旧表生成一个删除项，物理表名来自基线。
 * 依赖对应的写路径删除项（如 Message 表依赖 write_path:Message）。
 */
export function generateLegacyTableRemovalItems(
  baseline: readonly LegacyTableMapping[] = MAPPING_BASELINE,
): LegacyRemovalItem[] {
  return baseline.map((mapping) => {
    const objectName = mapping.legacyTable;
    const writePathKey = inferWritePathDependency(mapping);
    return {
      key: `table:${objectName}`,
      category: "legacy_table" as const,
      objectName,
      physicalTable: mapping.physicalTable,
      dependsOn: writePathKey ? [writePathKey] : [],
      requiresArchive: true,
      approvalConditions: [
        "对应写路径已删除",
        "迁移已完成且一致性报告通过",
        "归档副本已验证可恢复",
        "审批流程已通过",
      ],
      status: "pending" as RemovalItemStatus,
      archivedAt: null,
      removedAt: null,
      blockedReason: null,
    };
  });
}

/**
 * 推断旧表对应的写路径依赖。
 *
 * 规则：
 * - Message 表 → write_path:Message
 * - ThreadRun/ToolRun/RunTranscriptChunk → write_path:Run
 * - SubagentDefinition/SubagentRun → write_path:Subagent
 * - BackgroundTask → write_path:BackgroundTask
 * - 其他表无写路径依赖（返回 null）
 */
function inferWritePathDependency(mapping: LegacyTableMapping): string | null {
  const name = mapping.legacyTable;
  if (name === "Message") return `${WRITE_PATH_KEY_PREFIX}Message`;
  if (name === "ThreadRun" || name === "ToolRun" || name === "RunTranscriptChunk") {
    return `${WRITE_PATH_KEY_PREFIX}Run`;
  }
  if (name === "SubagentDefinition" || name === "SubagentRun") {
    return `${WRITE_PATH_KEY_PREFIX}Subagent`;
  }
  if (name === "BackgroundTask") return `${WRITE_PATH_KEY_PREFIX}BackgroundTask`;
  return null;
}

// ─── 标准旧写路径删除项 ────────────────────────────────────

/** 生成标准旧写路径删除项（5 项）。 */
export function generateWritePathRemovalItems(): LegacyRemovalItem[] {
  return LEGACY_WRITE_PATH_OBJECTS.map((obj) => ({
    key: `${WRITE_PATH_KEY_PREFIX}${obj}`,
    category: "legacy_write_path" as const,
    objectName: obj,
    physicalTable: null,
    dependsOn: [],
    requiresArchive: false,
    approvalConditions: ["切换已完成且观察窗口已过", "V11 对应写入口已通过验收", "无活跃写入流量"],
    status: "pending" as RemovalItemStatus,
    archivedAt: null,
    removedAt: null,
    blockedReason: null,
  }));
}

// ─── 完整删除清单生成 ──────────────────────────────────────

/**
 * 生成完整删除清单。
 *
 * 顺序：旧写路径 → 旧 API → 旧客户端 → 旧 Runtime → 旧表。
 * 旧表删除项依赖对应的写路径删除项。
 *
 * @param baseline 迁移映射基线（默认 MAPPING_BASELINE）
 * @param customItems 自定义删除项（旧 API/客户端/Runtime，生产环境补充）
 */
export function generateRemovalInventory(
  baseline: readonly LegacyTableMapping[] = MAPPING_BASELINE,
  customItems: readonly LegacyRemovalItem[] = [],
): LegacyRemovalItem[] {
  const writePathItems = generateWritePathRemovalItems();
  const tableItems = generateLegacyTableRemovalItems(baseline);

  // 自定义项按类别分组
  const apiItems = customItems.filter((i) => i.category === "legacy_api");
  const clientItems = customItems.filter((i) => i.category === "legacy_client");
  const runtimeItems = customItems.filter((i) => i.category === "legacy_runtime");

  return [...writePathItems, ...apiItems, ...clientItems, ...runtimeItems, ...tableItems];
}

// ─── 删除项状态更新工具 ────────────────────────────────────

/** 更新删除项状态。 */
export function updateItemStatus(
  item: LegacyRemovalItem,
  status: RemovalItemStatus,
  reason: string | null = null,
): LegacyRemovalItem {
  const now = new Date().toISOString();
  return {
    ...item,
    status,
    archivedAt: status === "archived" ? now : item.archivedAt,
    removedAt: status === "removed" ? now : item.removedAt,
    blockedReason: status === "blocked" ? reason : item.blockedReason,
  };
}

// ─── 删除清单统计 ──────────────────────────────────────────

/** 删除清单统计。 */
export interface RemovalInventoryStats {
  readonly totalItems: number;
  readonly byCategory: Record<
    LegacyRemovalCategory,
    { total: number; pending: number; archived: number; removed: number; blocked: number }
  >;
}

/** 计算删除清单统计。 */
export function getRemovalInventoryStats(
  items: readonly LegacyRemovalItem[],
): RemovalInventoryStats {
  const byCategory = {
    legacy_write_path: { total: 0, pending: 0, archived: 0, removed: 0, blocked: 0 },
    legacy_api: { total: 0, pending: 0, archived: 0, removed: 0, blocked: 0 },
    legacy_client: { total: 0, pending: 0, archived: 0, removed: 0, blocked: 0 },
    legacy_runtime: { total: 0, pending: 0, archived: 0, removed: 0, blocked: 0 },
    legacy_table: { total: 0, pending: 0, archived: 0, removed: 0, blocked: 0 },
  };

  for (const item of items) {
    const cat = byCategory[item.category];
    cat.total += 1;
    if (item.status === "pending") cat.pending += 1;
    else if (item.status === "archived") cat.archived += 1;
    else if (item.status === "removed") cat.removed += 1;
    else if (item.status === "blocked") cat.blocked += 1;
  }

  return { totalItems: items.length, byCategory };
}
