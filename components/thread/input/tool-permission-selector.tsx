"use client";

import { useThreadSettings } from "@/components/hooks/use-thread-settings";
import { Popover, PopoverContent, PopoverTitle, PopoverTrigger } from "@/components/ui/popover";
import { apiFetch } from "@/lib/api-fetch";
import type { ClientThreadResponse } from "@/lib/client/types";
import type { ToolPermissionMode } from "@/lib/permission/tool-permission-mode";
import { Check, ChevronDown, Shield } from "lucide-react";
import { useState } from "react";

const choices: { value: ToolPermissionMode; label: string; description: string }[] = [
  {
    value: "auto",
    label: "自动",
    description: "读取和搜索直接执行；隔离容器内命令自动执行，其他操作先询问。",
  },
  { value: "ask", label: "执行前询问", description: "每次调用工具前都由你确认。" },
  {
    value: "full_access",
    label: "完全访问",
    description: "允许在当前执行环境内读写和运行命令，不再逐次确认。",
  },
];

export function ToolPermissionSelector({
  threadId,
  value,
  onChange,
  disabled = false,
}: {
  threadId: string | null;
  value: ToolPermissionMode;
  onChange: (value: ToolPermissionMode) => void;
  disabled?: boolean;
}) {
  const [open, setOpen] = useState(false);
  const [saving, setSaving] = useState(false);
  const [loadError, setLoadError] = useState<string | null>(null);
  const { patchSettings, error } = useThreadSettings({ threadId: threadId ?? "" });
  const select = async (mode: ToolPermissionMode) => {
    if (saving || disabled) return;
    if (!threadId) {
      onChange(mode);
      setOpen(false);
      return;
    }
    setSaving(true);
    setLoadError(null);
    try {
      // 当前版本号可能已被执行事件推进；提交前读 Authority，PATCH 仍以 CAS 防竞态。
      const response = await apiFetch(`/api/threads/${threadId}`, { cache: "no-store" });
      if (!response.ok) throw new Error("无法读取会话设置，请重试。");
      const current = (await response.json()) as ClientThreadResponse;
      if (
        await patchSettings({
          expectedVersionNo: current.thread.version_no,
          updates: { tool_permission_mode: mode },
        })
      ) {
        onChange(mode);
        setOpen(false);
      }
    } catch {
      setLoadError("无法保存权限设置，请重试。");
    } finally {
      setSaving(false);
    }
  };
  return (
    <Popover open={open} onOpenChange={setOpen}>
      <PopoverTrigger
        disabled={disabled || saving}
        aria-label={`工具权限：${choices.find((choice) => choice.value === value)?.label}`}
      >
        <span className="inline-flex h-[30px] shrink-0 items-center gap-1 rounded-full px-2 text-xs text-muted-foreground hover:bg-muted">
          <Shield aria-hidden="true" className="size-3.5" />
          <span className="hidden whitespace-nowrap sm:inline">
            {choices.find((choice) => choice.value === value)?.label}
          </span>
          <ChevronDown aria-hidden="true" className="hidden size-3 sm:block" />
        </span>
      </PopoverTrigger>
      <PopoverContent side="top" align="end" className="w-72 max-w-[calc(100vw-24px)] p-2">
        <PopoverTitle className="px-2 py-1 text-sm">工具权限</PopoverTitle>
        <fieldset aria-label="权限模式">
          {choices.map((choice) => (
            <button
              key={choice.value}
              type="button"
              aria-pressed={value === choice.value}
              disabled={saving}
              onClick={() => void select(choice.value)}
              className="flex w-full gap-2 rounded-lg px-2 py-2 text-left hover:bg-muted disabled:opacity-50"
            >
              <span className="min-w-0 flex-1">
                <span className="block text-sm">{choice.label}</span>
                <span className="block text-xs leading-5 text-muted-foreground">
                  {choice.description}
                </span>
              </span>
              {value === choice.value ? (
                <Check aria-hidden="true" className="mt-1 size-3.5" />
              ) : null}
            </button>
          ))}
        </fieldset>
        <p className="px-2 pt-2 text-xs leading-5 text-muted-foreground">
          仅用于此会话的新执行。组织规定、网络范围和沙箱限制始终有效。
        </p>
        {error || loadError ? (
          <p role="alert" className="px-2 py-1 text-xs text-destructive">
            {loadError ?? error?.description}
          </p>
        ) : null}
      </PopoverContent>
    </Popover>
  );
}
