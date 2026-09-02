"use client";

import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { useMemo, useState } from "react";

/**
 * Phase 4-4 Stage B：prompt 行级 diff（自写 LCS，不引入 diff 库）。
 *
 * 仅对 skill_versions.promptTemplate 文本做行级比较。diffLines 是纯函数（可单测），
 * 组件层负责选版本 + 渲染着色（add 绿 / del 红 / same 灰）。
 */

export type DiffLine = { type: "same" | "add" | "del"; text: string };

/** 行级 LCS diff：返回 old→new 的最小编辑序列。 */
export function diffLines(oldText: string, newText: string): DiffLine[] {
  const a = oldText.split("\n");
  const b = newText.split("\n");
  const m = a.length;
  const n = b.length;
  // dp[i][j] = a[i:] 与 b[j:] 的 LCS 长度（全程已初始化，用 at 取值规避 noUncheckedIndexedAccess）
  const dp: number[][] = Array.from({ length: m + 1 }, () => new Array<number>(n + 1).fill(0));
  const at = (i: number, j: number): number => dp[i]?.[j] ?? 0;
  const set = (i: number, j: number, v: number): void => {
    const row = dp[i];
    if (row) row[j] = v;
  };
  for (let i = m - 1; i >= 0; i--) {
    for (let j = n - 1; j >= 0; j--) {
      set(i, j, a[i] === b[j] ? at(i + 1, j + 1) + 1 : Math.max(at(i + 1, j), at(i, j + 1)));
    }
  }
  const out: DiffLine[] = [];
  let i = 0;
  let j = 0;
  while (i < m && j < n) {
    if (a[i] === b[j]) {
      out.push({ type: "same", text: a[i] ?? "" });
      i++;
      j++;
    } else if (at(i + 1, j) >= at(i, j + 1)) {
      out.push({ type: "del", text: a[i] ?? "" });
      i++;
    } else {
      out.push({ type: "add", text: b[j] ?? "" });
      j++;
    }
  }
  while (i < m) {
    out.push({ type: "del", text: a[i] ?? "" });
    i++;
  }
  while (j < n) {
    out.push({ type: "add", text: b[j] ?? "" });
    j++;
  }
  return out;
}

type VersionLite = { id: string; version: number; promptTemplate: string | null };

const ROW_CLASS: Record<DiffLine["type"], string> = {
  add: "bg-success/10 text-success",
  del: "bg-destructive/10 text-destructive",
  same: "text-muted-foreground",
};

const PREFIX: Record<DiffLine["type"], string> = { add: "+", del: "-", same: " " };
const ACCESSIBLE_CHANGE: Record<DiffLine["type"], string | null> = {
  add: "新增",
  del: "删除",
  same: null,
};

export function PromptDiff({ versions }: { versions: VersionLite[] }) {
  const [aId, setAId] = useState(versions[0]?.id ?? "");
  const [bId, setBId] = useState(versions[versions.length - 1]?.id ?? "");

  const diff = useMemo<DiffLine[]>(() => {
    const a = versions.find((v) => v.id === aId);
    const b = versions.find((v) => v.id === bId);
    if (!a || !b) return [];
    return diffLines(a.promptTemplate ?? "", b.promptTemplate ?? "");
  }, [versions, aId, bId]);

  if (versions.length < 2) {
    return <p className="text-sm text-muted-foreground">至少需要两个版本才能进行内容对比。</p>;
  }

  return (
    <div className="space-y-4">
      <div className="flex flex-wrap items-center gap-3">
        <Select value={aId} onValueChange={(value) => setAId(value ?? "")}>
          <SelectTrigger aria-label="较早版本" className="min-w-32">
            <SelectValue />
          </SelectTrigger>
          <SelectContent>
            {versions.map((v) => (
              <SelectItem key={v.id} value={v.id}>
                版本 {v.version}
              </SelectItem>
            ))}
          </SelectContent>
        </Select>
        <span aria-hidden className="text-sm text-foreground-subtle">
          对比
        </span>
        <Select value={bId} onValueChange={(value) => setBId(value ?? "")}>
          <SelectTrigger aria-label="较新版本" className="min-w-32">
            <SelectValue />
          </SelectTrigger>
          <SelectContent>
            {versions.map((v) => (
              <SelectItem key={v.id} value={v.id}>
                版本 {v.version}
              </SelectItem>
            ))}
          </SelectContent>
        </Select>
      </div>
      <section
        aria-label="版本内容差异"
        className="max-h-96 overflow-auto bg-muted/40 p-4 font-mono text-xs leading-6 whitespace-pre"
      >
        {diff.map((line, idx) => (
          // biome-ignore lint/suspicious/noArrayIndexKey: diff 行无稳定 id，列表顺序固定不重排
          <div key={`row-${idx}`} className={`min-w-max px-2 ${ROW_CLASS[line.type]}`}>
            {ACCESSIBLE_CHANGE[line.type] && (
              <span className="sr-only">{ACCESSIBLE_CHANGE[line.type]}</span>
            )}
            <span aria-hidden className="select-none pr-2 opacity-60">
              {PREFIX[line.type]}
            </span>
            {line.text || " "}
          </div>
        ))}
      </section>
    </div>
  );
}
