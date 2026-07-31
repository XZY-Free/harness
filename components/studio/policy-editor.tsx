"use client";

import type { PolicyConfigRow } from "@/lib/db/schema";
import { useState } from "react";

/**
 * Phase 4-4 切片 B3：Policies 编辑器（client）。
 *
 * 以当前 DB rows 初始化表单：
 * - regex 数组（protectedPaths / commandDenyList）：多行 textarea，每行一个正则源。
 * - formatOnWrite：enabled checkbox + command input。
 * - verifyBeforeDelivery：enabled checkbox + command + timeoutMs number + timeoutIsFailure
 *   checkbox + testFilePattern input。
 *
 * 保存调用 PUT /studio/api/policies（整配置提交）。服务端校验是唯一可信边界；
 * 保存成功用返回 rows 回填本地状态,失败展示 error.message。
 */

type Row = { key: string; value: unknown };

function asStringArray(v: unknown): string[] {
  return Array.isArray(v) ? v.filter((x): x is string => typeof x === "string") : [];
}
function asObject(v: unknown): Record<string, unknown> {
  return typeof v === "object" && v !== null ? (v as Record<string, unknown>) : {};
}
function asBool(v: unknown, fallback: boolean): boolean {
  return typeof v === "boolean" ? v : fallback;
}
function asStr(v: unknown, fallback: string): string {
  return typeof v === "string" ? v : fallback;
}
function asNum(v: unknown, fallback: number): number {
  return typeof v === "number" && Number.isFinite(v) ? v : fallback;
}

function fromRows(rows: Row[]) {
  const byKey = new Map<string, unknown>();
  for (const r of rows) byKey.set(r.key, r.value);
  return {
    protectedPaths: asStringArray(byKey.get("protectedPaths")),
    commandDenyList: asStringArray(byKey.get("commandDenyList")),
    formatOnWrite: asObject(byKey.get("formatOnWrite")),
    verify: asObject(byKey.get("verifyBeforeDelivery")),
  };
}

function Field({
  label,
  hint,
  children,
}: { label: string; hint?: string; children: React.ReactNode }) {
  return (
    <section className="rounded-[var(--radius)] border border-[var(--border)] bg-[var(--surface)] p-4">
      <h2 className="mb-2 text-[14px] font-medium text-[var(--fg)]">{label}</h2>
      {hint && <p className="mb-2 text-[12px] text-[var(--fg-subtle)]">{hint}</p>}
      {children}
    </section>
  );
}

export function PolicyEditor({ rows }: { rows: PolicyConfigRow[] | Row[] }) {
  const initial = fromRows(rows);
  const [ppText, setPpText] = useState(initial.protectedPaths.join("\n"));
  const [denyText, setDenyText] = useState(initial.commandDenyList.join("\n"));
  const [fowEnabled, setFowEnabled] = useState(asBool(initial.formatOnWrite.enabled, true));
  const [fowCommand, setFowCommand] = useState(asStr(initial.formatOnWrite.command, ""));
  const [vEnabled, setVEnabled] = useState(asBool(initial.verify.enabled, true));
  const [vCommand, setVCommand] = useState(asStr(initial.verify.command, ""));
  const [vTimeout, setVTimeout] = useState(asNum(initial.verify.timeoutMs, 60_000));
  const [vTimeoutIsFailure, setVTimeoutIsFailure] = useState(
    asBool(initial.verify.timeoutIsFailure, false),
  );
  const [vPattern, setVPattern] = useState(asStr(initial.verify.testFilePattern, ""));

  const [saving, setSaving] = useState(false);
  const [message, setMessage] = useState<{ kind: "ok" | "error"; text: string } | null>(null);

  function linesToRegexArray(text: string): string[] {
    return text
      .split("\n")
      .map((l) => l.trim())
      .filter((l) => l.length > 0);
  }

  async function save() {
    setSaving(true);
    setMessage(null);
    const payload = {
      rows: [
        { key: "protectedPaths", value: linesToRegexArray(ppText) },
        { key: "commandDenyList", value: linesToRegexArray(denyText) },
        { key: "formatOnWrite", value: { enabled: fowEnabled, command: fowCommand } },
        {
          key: "verifyBeforeDelivery",
          value: {
            enabled: vEnabled,
            command: vCommand,
            timeoutMs: vTimeout,
            timeoutIsFailure: vTimeoutIsFailure,
            testFilePattern: vPattern,
          },
        },
      ],
    };
    try {
      const res = await fetch("/studio/api/policies", {
        method: "PUT",
        headers: { "content-type": "application/json" },
        body: JSON.stringify(payload),
      });
      const body = await res.json();
      if (res.ok) {
        // 用服务端规范化结果回填（去空白/丢弃未知字段后的真值）
        const next = fromRows(body.data.rows);
        setPpText(next.protectedPaths.join("\n"));
        setDenyText(next.commandDenyList.join("\n"));
        setFowEnabled(asBool(next.formatOnWrite.enabled, fowEnabled));
        setFowCommand(asStr(next.formatOnWrite.command, fowCommand));
        setVEnabled(asBool(next.verify.enabled, vEnabled));
        setVCommand(asStr(next.verify.command, vCommand));
        setVTimeout(asNum(next.verify.timeoutMs, vTimeout));
        setVTimeoutIsFailure(asBool(next.verify.timeoutIsFailure, vTimeoutIsFailure));
        setVPattern(asStr(next.verify.testFilePattern, vPattern));
        setMessage({ kind: "ok", text: "已保存" });
      } else {
        setMessage({ kind: "error", text: body?.error?.message ?? "保存失败" });
      }
    } catch {
      setMessage({ kind: "error", text: "网络错误" });
    } finally {
      setSaving(false);
    }
  }

  return (
    <div className="flex flex-col gap-3">
      <div className="flex items-center justify-end">
        <button
          type="button"
          onClick={save}
          disabled={saving}
          className="rounded-[var(--radius-sm)] bg-[var(--primary)] px-4 py-1.5 text-[13px] font-medium text-[var(--accent-fg)] transition hover:opacity-90 disabled:opacity-50"
        >
          {saving ? "保存中…" : "保存"}
        </button>
      </div>

      {message && (
        <div
          className={`rounded-[var(--radius-sm)] px-3 py-2 text-[13px] ${
            message.kind === "ok"
              ? "bg-[var(--accent-soft)] text-[var(--primary)]"
              : "bg-[var(--danger-soft)] text-[var(--danger)]"
          }`}
        >
          {message.text}
        </div>
      )}

      <div className="grid grid-cols-1 gap-3 md:grid-cols-2">
        <Field label="受保护路径（protectedPaths）" hint="每行一个正则源;空行忽略">
          <textarea
            value={ppText}
            onChange={(e) => setPpText(e.target.value)}
            rows={5}
            className="w-full rounded-[var(--radius-sm)] border border-[var(--border)] bg-[var(--bg)] p-2 font-mono text-[12px] text-[var(--fg)]"
            spellCheck={false}
          />
        </Field>

        <Field label="高危命令黑名单（commandDenyList）" hint="每行一个正则源;空行忽略">
          <textarea
            value={denyText}
            onChange={(e) => setDenyText(e.target.value)}
            rows={5}
            className="w-full rounded-[var(--radius-sm)] border border-[var(--border)] bg-[var(--bg)] p-2 font-mono text-[12px] text-[var(--fg)]"
            spellCheck={false}
          />
        </Field>

        <Field label="写后格式化（formatOnWrite）">
          <label className="flex items-center gap-2 text-[13px] text-[var(--fg)]">
            <input
              type="checkbox"
              checked={fowEnabled}
              onChange={(e) => setFowEnabled(e.target.checked)}
            />
            enabled
          </label>
          <label htmlFor="fow-command" className="mt-2 block text-[12px] text-[var(--fg-subtle)]">
            command（可空=no-op）
          </label>
          <input
            id="fow-command"
            type="text"
            value={fowCommand}
            onChange={(e) => setFowCommand(e.target.value)}
            className="mt-1 w-full rounded-[var(--radius-sm)] border border-[var(--border)] bg-[var(--bg)] p-2 font-mono text-[12px] text-[var(--fg)]"
            spellCheck={false}
          />
        </Field>

        <Field label="交付前验证（verifyBeforeDelivery）">
          <label className="flex items-center gap-2 text-[13px] text-[var(--fg)]">
            <input
              type="checkbox"
              checked={vEnabled}
              onChange={(e) => setVEnabled(e.target.checked)}
            />
            enabled
          </label>
          <label htmlFor="v-command" className="mt-2 block text-[12px] text-[var(--fg-subtle)]">
            command
          </label>
          <input
            id="v-command"
            type="text"
            value={vCommand}
            onChange={(e) => setVCommand(e.target.value)}
            className="mt-1 w-full rounded-[var(--radius-sm)] border border-[var(--border)] bg-[var(--bg)] p-2 font-mono text-[12px] text-[var(--fg)]"
            spellCheck={false}
          />
          <label htmlFor="v-timeout" className="mt-2 block text-[12px] text-[var(--fg-subtle)]">
            timeoutMs（1000..300000 整数）
          </label>
          <input
            id="v-timeout"
            type="number"
            value={vTimeout}
            onChange={(e) => setVTimeout(Number(e.target.value))}
            className="mt-1 w-full rounded-[var(--radius-sm)] border border-[var(--border)] bg-[var(--bg)] p-2 font-mono text-[12px] text-[var(--fg)]"
          />
          <label className="mt-2 flex items-center gap-2 text-[13px] text-[var(--fg)]">
            <input
              type="checkbox"
              checked={vTimeoutIsFailure}
              onChange={(e) => setVTimeoutIsFailure(e.target.checked)}
            />
            timeoutIsFailure（超时算失败）
          </label>
          <label htmlFor="v-pattern" className="mt-2 block text-[12px] text-[var(--fg-subtle)]">
            testFilePattern（正则源）
          </label>
          <input
            id="v-pattern"
            type="text"
            value={vPattern}
            onChange={(e) => setVPattern(e.target.value)}
            className="mt-1 w-full rounded-[var(--radius-sm)] border border-[var(--border)] bg-[var(--bg)] p-2 font-mono text-[12px] text-[var(--fg)]"
            spellCheck={false}
          />
        </Field>
      </div>
    </div>
  );
}
