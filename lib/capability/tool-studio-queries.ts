/**
 * Studio 侧 Tool/MCP 列表查询（带同步状态）。
 *
 * 事实源：Tool / ToolProvider 正式表 + ToolSyncBinding（同步元数据）。
 * 只读投影；写操作仍走各自守卫。仅供 Studio 展示。
 */
import { db } from "@/lib/db/client";
import { toolProviderTable, toolTable } from "@/lib/persistence/schema/tool";
import { toolSyncBindingTable } from "@/lib/persistence/schema/tool-sync";
import { and, asc, eq, isNull } from "drizzle-orm";

/** Studio Tool 列表行（wire 形状，仅展示所需字段）。 */
export interface StudioToolRow {
  id: string;
  toolKey: string;
  displayName: string;
  description: string | null;
  lifecycleState: string;
  riskClass: string;
  providerKey: string;
  providerType: string;
  /** 同步态（非同步来源则为 null）。 */
  syncState: string | null;
  syncAssetType: string | null;
  lastSyncedAt: string | null;
}

/**
 * 列出 Studio 可见 Tool（含同步态）。
 *
 * @param tenantId 租户
 */
export async function listStudioTools(tenantId: string): Promise<StudioToolRow[]> {
  const rows = await db
    .select({
      tool: toolTable,
      provider: toolProviderTable,
      binding: toolSyncBindingTable,
    })
    .from(toolTable)
    .innerJoin(toolProviderTable, eq(toolProviderTable.id, toolTable.providerId))
    .leftJoin(
      toolSyncBindingTable,
      and(
        eq(toolSyncBindingTable.tenantId, tenantId),
        eq(toolSyncBindingTable.localProviderId, toolProviderTable.id),
      ),
    )
    .where(and(eq(toolTable.tenantId, tenantId), isNull(toolTable.deletedAt)))
    .orderBy(asc(toolProviderTable.providerKey), asc(toolTable.toolKey));

  return rows.map((r) => ({
    id: r.tool.id,
    toolKey: r.tool.toolKey,
    displayName: r.tool.displayName,
    description: r.tool.description,
    lifecycleState: r.tool.lifecycleState,
    riskClass: r.tool.riskClass,
    providerKey: r.provider.providerKey,
    providerType: r.provider.providerType,
    syncState: r.binding?.syncState ?? null,
    syncAssetType: r.binding?.assetType ?? null,
    lastSyncedAt: r.binding?.lastSyncedAt ? r.binding.lastSyncedAt.toISOString() : null,
  }));
}
