/**
 * Catalog 单选下拉组件（S10-W04）。
 *
 * 事实源：
 * - docs/architecture/product-surfaces-and-admin.md
 *   S10-W04：「员工选择 Agent / Skill / Model / Environment」
 *
 * 职责：
 * - 接受 resourceType + value + onChange，从 Catalog API 拉取选项列表。
 * - 渲染原生 <select>（无障碍、键盘可达）。
 * - loading 时 disabled + 显示 "加载中…"。
 * - 错误时显示 "目录加载失败" 但仍允许保留当前值。
 *
 * 不变量：
 * - 受控组件：value 必填，onChange 必填。
 * - 选项 id = resource_id，label = display_name。
 *
 * 使用：
 * ```tsx
 * <CatalogSelect
 *   resourceType="agent"
 *   value={thread.primary_agent_id}
 *   onChange={(id) => updateSettings({ default_agent_id: id })}
 *   label="主 Agent"
 * />
 * ```
 */
"use client";

import { useCatalog } from "@/components/hooks/use-catalog";
import { cn } from "@/lib/utils";
import type { ClientCatalogResourceType } from "@/lib/client/types";
import { useId } from "react";

interface CatalogSelectProps {
  readonly resourceType: ClientCatalogResourceType;
  readonly value: string | null;
  readonly onChange: (value: string) => void;
  /** 标签（无障碍 aria-label）。 */
  readonly label: string;
  /** 是否禁用。 */
  readonly disabled?: boolean;
  /** 占位符（默认 "请选择"）。 */
  readonly placeholder?: string;
  /** 是否允许 "无" 选项（清空）。默认 false。 */
  readonly allowClear?: boolean;
  /** 排除某些 resource_id（如当前主 Agent 不允许在 handoff 中作为目标）。 */
  readonly excludeIds?: readonly string[];
}

export function CatalogSelect({
  resourceType,
  value,
  onChange,
  label,
  disabled = false,
  placeholder = "请选择",
  allowClear = false,
  excludeIds = [],
}: CatalogSelectProps) {
  const { items, loading, error } = useCatalog({
    resourceTypes: [resourceType],
  });
  const selectId = useId();

  const visibleItems = items.filter((it) => !excludeIds.includes(it.resource_id));
  const isDisabled = disabled || loading;

  return (
    <div className="flex min-w-0 flex-1 flex-col gap-1">
      <label
        htmlFor={selectId}
        className="text-3xs font-medium text-foreground-subtle uppercase tracking-wide"
      >
        {label}
      </label>
      <select
        id={selectId}
        value={value ?? ""}
        onChange={(e) => onChange(e.target.value)}
        disabled={isDisabled}
        aria-label={label}
        aria-busy={loading}
        className={cn(
          "rounded-[var(--radius-sm)] border border-border bg-background px-2 py-1.5 text-xs text-foreground outline-none transition",
          "focus:border-primary/60 focus:shadow-[0_0_0_2px_var(--accent-soft)]",
          "disabled:cursor-not-allowed disabled:opacity-50",
        )}
      >
        {allowClear && <option value="">（无）</option>}
        {!allowClear && !value && (
          <option value="" disabled>
            {loading ? "加载中…" : placeholder}
          </option>
        )}
        {visibleItems.map((it) => {
          const isDisabledOption = it.lifecycle_state !== "enabled";
          return (
            <option key={it.resource_id} value={it.resource_id} disabled={isDisabledOption}>
              {it.display_name}
              {isDisabledOption ? "（已禁用）" : ""}
            </option>
          );
        })}
      </select>
      {error && (
        <span className="text-3xs text-destructive" role="alert">
          目录加载失败：{error.description}
        </span>
      )}
    </div>
  );
}
