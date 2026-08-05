/**
 * V11 Catalog 显示名组件（S10-W04）。
 *
 * 事实源：
 * - docs/solutions/v11-agentkit-platform-development-plan/10-employee-web-and-desktop-experience.md
 *   S10-W04：「Thread 顶部展示 Agent 显示名 / Environment 显示名」
 *
 * 职责：
 * - 接受 resourceId + resourceType，自动从 Catalog API 拉取 display_name。
 * - loading 时显示截断 id（fallback）；找不到时显示截断 id + "(已禁用)"。
 * - 不影响布局：返回 inline <span>，无 wrapper div。
 *
 * 使用：
 * ```tsx
 * <CatalogDisplayName resourceId={thread.primary_agent_id} resourceType="agent" />
 * ```
 */
"use client";

import { useV11Catalog } from "@/components/hooks/use-v11-catalog";
import type { ClientCatalogResourceType } from "@/lib/v11/client/types";

interface CatalogDisplayNameProps {
  readonly resourceId: string;
  readonly resourceType: ClientCatalogResourceType;
  /** 自定义 fallback 文本（默认为 resourceId 截断前 8 位）。 */
  readonly fallback?: string;
}

export function CatalogDisplayName({
  resourceId,
  resourceType,
  fallback,
}: CatalogDisplayNameProps) {
  const { items, loading } = useV11Catalog({
    resourceTypes: [resourceType],
  });

  const fallbackText = fallback ?? resourceId.slice(0, 8);
  const matched = items.find((it) => it.resource_id === resourceId);

  if (loading && !matched) {
    return <span className="font-mono text-2xs text-foreground-subtle">{fallbackText}</span>;
  }

  if (!matched) {
    // 资源不在 catalog 中（可能已禁用或跨租户不可见）
    return (
      <span className="font-mono text-2xs text-foreground-subtle">
        {fallbackText}
        <span className="ml-1 text-3xs text-foreground-subtle">(未知)</span>
      </span>
    );
  }

  // 找到匹配项；如 lifecycle_state != enabled，附加提示
  const isDisabled = matched.lifecycle_state !== "enabled";
  return (
    <span className="text-xs text-foreground">
      {matched.display_name}
      {isDisabled && <span className="ml-1 text-3xs text-foreground-subtle">(已禁用)</span>}
    </span>
  );
}
