"use client";
import { Checkbox } from "@/components/ui/checkbox";
import { Input } from "@/components/ui/input";
import { useId, useState } from "react";
export interface PermissionSubjectOption {
  id: string;
  label: string;
  description?: string;
}
export function PermissionSubjectPicker({
  label,
  options,
  value,
  onChange,
  disabled = false,
}: {
  label: string;
  options: PermissionSubjectOption[];
  value: string[];
  onChange: (value: string[]) => void;
  disabled?: boolean;
}) {
  const prefix = useId();
  const [query, setQuery] = useState("");
  const filtered = options.filter((o) =>
    `${o.label} ${o.description ?? ""}`.toLowerCase().includes(query.toLowerCase()),
  );
  return (
    <fieldset disabled={disabled} className="space-y-3">
      <legend className="mb-2 text-sm font-medium">{label}</legend>
      <Input
        aria-label={`搜索${label}`}
        placeholder="搜索成员或用户组"
        value={query}
        onChange={(e) => setQuery(e.target.value)}
      />
      <div className="max-h-64 space-y-1 overflow-auto rounded-xl border p-2">
        {filtered.map((o) => (
          <div
            key={o.id}
            className="flex cursor-pointer items-start gap-3 rounded-lg px-2 py-2 text-sm hover:bg-muted"
          >
            <Checkbox
              id={`${prefix}-${o.id}`}
              disabled={disabled}
              checked={value.includes(o.id)}
              onCheckedChange={(checked) =>
                onChange(checked ? [...value, o.id] : value.filter((id) => id !== o.id))
              }
            />
            <label htmlFor={`${prefix}-${o.id}`} className="min-w-0 cursor-pointer break-words">
              {o.label}
              {o.description && (
                <span className="mt-0.5 block text-xs text-muted-foreground">{o.description}</span>
              )}
            </label>
          </div>
        ))}
        {!filtered.length && (
          <p className="p-2 text-sm text-muted-foreground">没有匹配的成员或用户组</p>
        )}
      </div>
      <p className="text-xs text-muted-foreground">已选择 {value.length} 项</p>
    </fieldset>
  );
}
