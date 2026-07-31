"use client";

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
  add: "bg-[var(--ok-soft)] text-[var(--ok)]",
  del: "bg-[var(--danger-soft)] text-[var(--danger)]",
  same: "text-[var(--fg-subtle)]",
};

const PREFIX: Record<DiffLine["type"], string> = { add: "+", del: "-", same: " " };

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
    return <div className="text-[13px] text-[var(--fg-muted)]">至少需要 2 个版本才能对比。</div>;
  }

  return (
    <div>
      <div className="mb-3 flex items-center gap-3 text-[13px]">
        <label className="flex items-center gap-1.5">
          旧
          <select
            value={aId}
            onChange={(e) => setAId(e.target.value)}
            className="rounded-[var(--radius-sm)] border border-[var(--border)] bg-[var(--surface)] px-2 py-1"
          >
            {versions.map((v) => (
              <option key={v.id} value={v.id}>
                v{v.version}
              </option>
            ))}
          </select>
        </label>
        <label className="flex items-center gap-1.5">
          新
          <select
            value={bId}
            onChange={(e) => setBId(e.target.value)}
            className="rounded-[var(--radius-sm)] border border-[var(--border)] bg-[var(--surface)] px-2 py-1"
          >
            {versions.map((v) => (
              <option key={v.id} value={v.id}>
                v{v.version}
              </option>
            ))}
          </select>
        </label>
      </div>
      <pre className="overflow-auto rounded-[var(--radius)] border border-[var(--border)] bg-[var(--surface)] p-3 text-[12px] leading-[1.6]">
        {diff.map((line, idx) => (
          // biome-ignore lint/suspicious/noArrayIndexKey: diff 行无稳定 id，列表顺序固定不重排
          <div key={`row-${idx}`} className={`px-2 ${ROW_CLASS[line.type]}`}>
            <span className="select-none pr-2 opacity-60">{PREFIX[line.type]}</span>
            {line.text || " "}
          </div>
        ))}
      </pre>
    </div>
  );
}
