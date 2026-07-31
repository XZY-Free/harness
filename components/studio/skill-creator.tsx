"use client";

import { useRouter } from "next/navigation";
import { useState } from "react";

/**
 * 新建技能对话框。POST /studio/api/skills → 建目录 + SKILL.md + v1。
 * name 校验由后端 assertValidSkillName 兜底,前端只做非空。
 */
export function SkillCreator() {
  const router = useRouter();
  const [open, setOpen] = useState(false);
  const [name, setName] = useState("");
  const [description, setDescription] = useState("");
  const [tools, setTools] = useState(
    "writeFile,readFile,listFiles,runCommand,runTests,reportReady",
  );
  const [promptMd, setPromptMd] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function submit() {
    if (!name.trim() || busy) return;
    setBusy(true);
    setError(null);
    try {
      const res = await fetch("/studio/api/skills", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          name: name.trim(),
          description: description.trim(),
          tools: tools
            .split(",")
            .map((s) => s.trim())
            .filter(Boolean),
          promptMd,
        }),
      });
      const body = await res.json();
      if (!res.ok) {
        setError(body?.error?.message ?? `HTTP ${res.status}`);
        return;
      }
      setOpen(false);
      setName("");
      setDescription("");
      setPromptMd("");
      router.refresh();
    } catch (e) {
      setError(e instanceof Error ? e.message : "网络错误");
    } finally {
      setBusy(false);
    }
  }

  return (
    <div>
      <button
        type="button"
        onClick={() => setOpen(true)}
        className="flex items-center gap-1.5 rounded-[var(--radius-sm)] bg-[var(--primary)] px-3 py-1.5 text-[13px] font-medium text-[var(--accent-fg)] transition hover:bg-[var(--accent-hover)]"
      >
        + 新建技能
      </button>
      {open && (
        <div
          className="fixed inset-0 z-50 flex items-center justify-center bg-black/40 p-4"
          onClick={() => setOpen(false)}
          onKeyDown={(e) => {
            if (e.key === "Escape") setOpen(false);
          }}
        >
          <div
            className="w-full max-w-lg rounded-[var(--radius)] bg-[var(--surface)] p-5"
            onClick={(e) => e.stopPropagation()}
            onKeyDown={(e) => e.stopPropagation()}
          >
            <h2 className="text-[16px] font-semibold text-[var(--fg)]">新建技能</h2>
            <div className="mt-4 space-y-3 text-[13px]">
              <label className="block">
                <span className="text-[var(--fg-muted)]">name（小写字母数字+连字符）</span>
                <input
                  value={name}
                  onChange={(e) => setName(e.target.value)}
                  placeholder="build-from-idea"
                  className="mt-1 w-full rounded-[var(--radius-sm)] bg-[var(--bg)] px-2.5 py-1.5 font-mono outline-none ring-1 ring-[var(--border)] focus:ring-[var(--accent-ring)]"
                />
              </label>
              <label className="block">
                <span className="text-[var(--fg-muted)]">描述</span>
                <input
                  value={description}
                  onChange={(e) => setDescription(e.target.value)}
                  className="mt-1 w-full rounded-[var(--radius-sm)] bg-[var(--bg)] px-2.5 py-1.5 outline-none ring-1 ring-[var(--border)] focus:ring-[var(--accent-ring)]"
                />
              </label>
              <label className="block">
                <span className="text-[var(--fg-muted)]">工具白名单（逗号分隔）</span>
                <input
                  value={tools}
                  onChange={(e) => setTools(e.target.value)}
                  className="mt-1 w-full rounded-[var(--radius-sm)] bg-[var(--bg)] px-2.5 py-1.5 font-mono text-[12px] outline-none ring-1 ring-[var(--border)] focus:ring-[var(--accent-ring)]"
                />
              </label>
              <label className="block">
                <span className="text-[var(--fg-muted)]">SKILL.md 正文（工作指令）</span>
                <textarea
                  value={promptMd}
                  onChange={(e) => setPromptMd(e.target.value)}
                  rows={8}
                  placeholder="# 技能指令&#10;agent 会通过 readSkillFile 读取本文件..."
                  className="mt-1 w-full rounded-[var(--radius-sm)] bg-[var(--bg)] px-2.5 py-1.5 font-mono text-[12px] outline-none ring-1 ring-[var(--border)] focus:ring-[var(--accent-ring)]"
                />
              </label>
            </div>
            {error && <div className="mt-3 text-[12px] text-[var(--danger)]">{error}</div>}
            <div className="mt-4 flex justify-end gap-2">
              <button
                type="button"
                onClick={() => setOpen(false)}
                className="rounded-[var(--radius-sm)] border border-[var(--border)] px-3 py-1.5 text-[13px] text-[var(--fg-muted)]"
              >
                取消
              </button>
              <button
                type="button"
                onClick={submit}
                disabled={busy || !name.trim()}
                className="rounded-[var(--radius-sm)] bg-[var(--primary)] px-3 py-1.5 text-[13px] font-medium text-[var(--accent-fg)] disabled:opacity-40"
              >
                {busy ? "创建中…" : "创建"}
              </button>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}
