"use client";

import { useRouter } from "next/navigation";
import { useEffect, useState } from "react";

/**
 * Skill 文件编辑器：文件树 + textarea 编辑工作副本 + 保存 + 发布新版本。
 * 保存（PUT /files）只写工作副本,不自动 commit；发布（POST /versions）才 git commit 建版本。
 */
export function SkillFileEditor({
  skillId,
  skillName,
  canWrite,
}: {
  skillId: string;
  skillName: string;
  canWrite: boolean;
}) {
  const router = useRouter();
  const [files, setFiles] = useState<string[]>([]);
  const [current, setCurrent] = useState<string | null>(null);
  const [content, setContent] = useState("");
  const [dirty, setDirty] = useState(false);
  const [busy, setBusy] = useState(false);
  const [msg, setMsg] = useState<string | null>(null);

  async function loadFiles() {
    const res = await fetch(`/studio/api/skills/${skillId}/files`);
    const body = await res.json();
    setFiles(body.data?.files ?? []);
  }
  useEffect(() => {
    let cancelled = false;
    fetch(`/studio/api/skills/${skillId}/files`)
      .then((r) => r.json())
      .then((b) => {
        if (!cancelled) setFiles(b.data?.files ?? []);
      });
    return () => {
      cancelled = true;
    };
  }, [skillId]);

  async function openFile(path: string) {
    if (dirty && !confirm("当前文件未保存,切换将丢弃改动,继续?")) return;
    const res = await fetch(`/studio/api/skills/${skillId}/files?path=${encodeURIComponent(path)}`);
    const body = await res.json();
    setCurrent(path);
    setContent(body.data?.content ?? "");
    setDirty(false);
    setMsg(null);
  }

  async function save() {
    if (!current || busy) return;
    setBusy(true);
    setMsg(null);
    const res = await fetch(`/studio/api/skills/${skillId}/files`, {
      method: "PUT",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ path: current, content }),
    });
    setBusy(false);
    if (res.ok) {
      setDirty(false);
      setMsg("已保存（未发布版本）");
    } else {
      setMsg("保存失败");
    }
  }

  async function publish() {
    if (busy) return;
    setBusy(true);
    setMsg(null);
    const res = await fetch(`/studio/api/skills/${skillId}/versions`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ message: `${skillName} 新版本` }),
    });
    const body = await res.json();
    setBusy(false);
    if (res.ok) {
      setMsg(`已发布 v${body.data?.version}（${body.data?.commitSha?.slice(0, 7)}）`);
      setDirty(false);
      router.refresh();
      loadFiles();
    } else {
      setMsg(body?.error?.message ?? "发布失败");
    }
  }

  return (
    <div className="rounded-[var(--radius)] border border-[var(--border)] bg-[var(--surface)]">
      <div className="flex items-center justify-between border-b border-[var(--border)] px-4 py-2.5">
        <h2 className="text-[15px] font-medium text-[var(--fg)]">文件</h2>
        {canWrite && (
          <button
            type="button"
            onClick={publish}
            disabled={busy}
            className="rounded-[var(--radius-sm)] bg-[var(--primary)] px-3 py-1.5 text-[12px] font-medium text-[var(--accent-fg)] disabled:opacity-40"
          >
            {busy ? "处理中…" : "发布新版本"}
          </button>
        )}
      </div>
      <div className="flex min-h-[320px]">
        <ul className="w-[180px] shrink-0 border-r border-[var(--border)] p-2 text-[12px]">
          {files.map((f) => (
            <li key={f}>
              <button
                type="button"
                onClick={() => openFile(f)}
                className={`w-full truncate rounded px-2 py-1 text-left font-mono hover:bg-[var(--surface-2)] ${
                  current === f
                    ? "bg-[var(--surface-2)] text-[var(--primary)]"
                    : "text-[var(--fg-muted)]"
                }`}
              >
                {f}
              </button>
            </li>
          ))}
        </ul>
        <div className="min-w-0 flex-1">
          {current ? (
            <textarea
              value={content}
              onChange={(e) => {
                setContent(e.target.value);
                setDirty(true);
                setMsg(null);
              }}
              readOnly={!canWrite}
              className="h-[320px] w-full resize-none bg-transparent p-3 font-mono text-[12px] outline-none"
            />
          ) : (
            <div className="p-6 text-[13px] text-[var(--fg-muted)]">选择左侧文件查看 / 编辑</div>
          )}
        </div>
      </div>
      {canWrite && current && (
        <div className="flex items-center justify-between border-t border-[var(--border)] px-4 py-2">
          <span className="text-[12px] text-[var(--fg-muted)]">
            {msg ?? (dirty ? "未保存" : "")}
          </span>
          <button
            type="button"
            onClick={save}
            disabled={busy || !dirty}
            className="rounded-[var(--radius-sm)] border border-[var(--border)] px-3 py-1 text-[12px] text-[var(--fg-muted)] disabled:opacity-40"
          >
            保存
          </button>
        </div>
      )}
    </div>
  );
}
