/**
 * V11 Thread 设置条幅（S10-W04）。
 *
 * 事实源：
 * - docs/solutions/v11-agentkit-platform-development-plan/10-employee-web-and-desktop-experience.md
 *   S10-W04：「员工在发送消息前选择 Agent / Model / Skill / Environment」
 *
 * 职责：
 * - 在 thread-input 上方渲染 4 个 CatalogSelect：Agent / Model / Skill / Environment。
 * - 任意字段变化时调用对应 onChange；调用方负责 PATCH /api/v1/threads/{id}/settings。
 * - 折叠/展开切换（默认折叠；点击 "高级设置" 展开）。
 * - Agent 字段变化时不直接 PATCH settings（因为 primary_agent_id 不可直接修改），
 *   而是触发 onChange 通知父组件，由父组件引导员工走 :change-primary-agent 路径。
 *
 * 设计权衡：
 * - 折叠默认值：折叠（避免占用过多空间）；员工需要切换时手动展开。
 * - 字段映射：
 *   - primary_agent_id → Agent（仅展示，变更走 :change-primary-agent；通过 onAgentChange 通知）
 *   - default_model_ref → Model（PATCH settings）
 *   - default_environment_definition_id → Environment（PATCH settings；resourceType=runtime）
 *   - Skill → 当前阶段为占位（Skill 由 Agent 内部决定，不允许员工直接覆盖）
 *
 * 使用：
 * ```tsx
 * <CatalogSettingsBar
 *   thread={thread}
 *   onAgentChange={(id) => handleChangeAgent(id)}
 *   onModelChange={(id) => handlePatchSettings({ default_model_ref: id })}
 *   onEnvironmentChange={(id) => handlePatchSettings({ default_environment_definition_id: id })}
 * />
 * ```
 */
"use client";

import { CatalogSelect } from "@/components/v11/catalog/catalog-select";
import { cn } from "@/lib/utils";
import type { V11ClientThread } from "@/lib/v11/client/types";
import { useState } from "react";

interface CatalogSettingsBarProps {
  readonly thread: V11ClientThread;
  /** Agent 变更请求（不直接 PATCH settings；走 :change-primary-agent）。 */
  readonly onAgentChange?: (agentId: string) => void;
  /** Model 变更（PATCH settings.default_model_ref）。 */
  readonly onModelChange?: (modelRef: string) => void;
  /** Environment 变更（PATCH settings.default_environment_definition_id）。 */
  readonly onEnvironmentChange?: (envDefId: string) => void;
  /** 是否禁用所有控件（如 PATCH 进行中）。 */
  readonly busy?: boolean;
}

export function CatalogSettingsBar({
  thread,
  onAgentChange,
  onModelChange,
  onEnvironmentChange,
  busy = false,
}: CatalogSettingsBarProps) {
  const [expanded, setExpanded] = useState(false);

  return (
    <div className="border-border border-b bg-card/60 px-4 py-2 lg:px-6">
      <div className="mx-auto max-w-3xl">
        {/* 折叠头：当前关键设置 + 展开按钮 */}
        <div className="flex items-center justify-between gap-2">
          <div className="flex min-w-0 flex-1 items-center gap-2 text-2xs text-muted-foreground">
            <span className="shrink-0 text-foreground-subtle">当前设置</span>
            <span className="truncate">
              Agent <span className="font-mono">{thread.primary_agent_id.slice(0, 8)}</span>
            </span>
            {thread.default_model_ref && (
              <span className="truncate">
                · Model <span className="font-mono">{thread.default_model_ref.slice(0, 12)}</span>
              </span>
            )}
            {thread.default_environment_definition_id && (
              <span className="truncate">
                · 位置{" "}
                <span className="font-mono">
                  {thread.default_environment_definition_id.slice(0, 8)}
                </span>
              </span>
            )}
          </div>
          <button
            type="button"
            onClick={() => setExpanded((v) => !v)}
            aria-expanded={expanded}
            aria-controls="catalog-settings-bar-content"
            className={cn(
              "shrink-0 rounded-[var(--radius-sm)] border border-border px-2 py-0.5 text-2xs text-muted-foreground transition",
              "hover:bg-background hover:text-foreground",
              "disabled:cursor-not-allowed disabled:opacity-50",
            )}
            disabled={busy}
          >
            {expanded ? "收起" : "高级设置"}
          </button>
        </div>

        {/* 展开内容：4 个选择器（实际 3 个；Skill 当前不开放员工选择） */}
        {expanded && (
          <div
            id="catalog-settings-bar-content"
            className="mt-2 grid grid-cols-1 gap-2 sm:grid-cols-3"
          >
            <CatalogSelect
              resourceType="agent"
              label="主 Agent"
              value={thread.primary_agent_id}
              onChange={(id) => onAgentChange?.(id)}
              disabled={busy || !onAgentChange}
              placeholder="选择 Agent"
            />
            <CatalogSelect
              resourceType="model"
              label="默认模型"
              value={thread.default_model_ref}
              onChange={(id) => onModelChange?.(id)}
              disabled={busy || !onModelChange}
              placeholder="选择模型"
              allowClear
            />
            <CatalogSelect
              resourceType="runtime"
              label="执行位置"
              value={thread.default_environment_definition_id}
              onChange={(id) => onEnvironmentChange?.(id)}
              disabled={busy || !onEnvironmentChange}
              placeholder="选择执行位置"
              allowClear
            />
          </div>
        )}

        {expanded && (
          <p className="mt-1.5 text-3xs text-foreground-subtle">
            主 Agent 变更需走交接流程（Handoff）。模型与位置变更将作为 Thread 默认设置应用到后续
            Turn。
          </p>
        )}
      </div>
    </div>
  );
}
