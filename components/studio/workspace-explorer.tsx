"use client";

import { useCallback, useState } from "react";

/**
 * Phase 4-4 切片 B2：工作区文件浏览器（client component）。
 *
 * 文件列表 + 选中查看内容（GET /workspace/[...path]）+ 编辑 textarea 保存
 * （POST /workspace，仅 canWrite）+ 删除按钮（DELETE，仅 canWrite）+ stat 展示。
 * 无 workspace.write → 只读模式（隐藏编辑 / 删除控件）。
 */

type FileStat = { size: number; mtime: string; isDirectory: boolean } | null;

type SelectedFile = {
  path: string;
  content: string;
  stat: FileStat;
};

export function WorkspaceExplorer({
  threadId,
  files,
  canWrite,
}: {
  threadId: string;
  files: string[];
  canWrite: boolean;
}) {
  const [selected, setSelected] = useState<SelectedFile | null>(null);
  const [draft, setDraft] = useState("");
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [saved, setSaved] = useState(false);
  const [fileList, setFileList] = useState<string[]>(files);

  const openFile = useCallback(
    async (path: string) => {
      setLoading(true);
      setError(null);
      setSaved(false);
      try {
        const res = await fetch(
          `/studio/api/threads/${threadId}/workspace/${path.split("/").map(encodeURIComponent).join("/")}`,
        );
        const body = await res.json();
        if (!res.ok) {
          setError(body?.error?.message ?? `读取失败（${res.status}）`);
          return;
        }
        setSelected({ path, content: body.data.content, stat: body.data.stat });
        setDraft(body.data.content);
      } catch {
        setError("网络错误：读取失败");
      } finally {
        setLoading(false);
      }
    },
    [threadId],
  );

  const saveFile = useCallback(async () => {
    if (!selected) return;
    setLoading(true);
    setError(null);
    setSaved(false);
    try {
      const res = await fetch(`/studio/api/threads/${threadId}/workspace`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ path: selected.path, content: draft }),
      });
      const body = await res.json();
      if (!res.ok) {
        setError(body?.error?.message ?? `保存失败（${res.status}）`);
        return;
      }
      setSelected({ ...selected, content: draft });
      setSaved(true);
    } catch {
      setError("网络错误：保存失败");
    } finally {
      setLoading(false);
    }
  }, [threadId, selected, draft]);

  const deleteFile = useCallback(
    async (path: string) => {
      if (!canWrite) return;
      if (!window.confirm(`确认删除文件 ${path}？删除即物理删除，不可恢复。`)) return;
      setLoading(true);
      setError(null);
      try {
        const res = await fetch(
          `/studio/api/threads/${threadId}/workspace/${path.split("/").map(encodeURIComponent).join("/")}`,
          {
            method: "DELETE",
          },
        );
        const body = await res.json();
        if (!res.ok) {
          setError(body?.error?.message ?? `删除失败（${res.status}）`);
          return;
        }
        setFileList((prev) => prev.filter((f) => f !== path));
        if (selected?.path === path) setSelected(null);
      } catch {
        setError("网络错误：删除失败");
      } finally {
        setLoading(false);
      }
    },
    [threadId, canWrite, selected],
  );

  return (
    <div className="mt-4 grid grid-cols-1 gap-4 md:grid-cols-[260px_1fr]">
      <section className="rounded-[var(--radius)] border border-[var(--border)] bg-[var(--surface)] p-3">
        <div className="mb-2 text-[12px] font-semibold uppercase tracking-wider text-[var(--fg-subtle)]">
          文件（{fileList.length}）
        </div>
        {fileList.length === 0 ? (
          <div className="py-4 text-center text-[13px] text-[var(--fg-muted)]">工作区为空。</div>
        ) : (
          <ul className="space-y-0.5 text-[13px]">
            {fileList.map((f) => (
              <li key={f} className="flex items-center gap-1">
                <button
                  type="button"
                  onClick={() => openFile(f)}
                  className={`flex-1 truncate rounded-[var(--radius-sm)] px-2 py-1 text-left font-mono hover:bg-[var(--surface-2)] ${
                    selected?.path === f
                      ? "bg-[var(--accent-soft)] text-[var(--primary)]"
                      : "text-[var(--fg-muted)]"
                  }`}
                >
                  {f}
                </button>
                {canWrite && (
                  <button
                    type="button"
                    onClick={() => deleteFile(f)}
                    className="shrink-0 rounded-[var(--radius-sm)] px-1.5 py-1 text-[12px] text-[var(--danger, var(--fg-subtle))] hover:bg-[var(--surface-2)]"
                    aria-label={`删除 ${f}`}
                  >
                    ✕
                  </button>
                )}
              </li>
            ))}
          </ul>
        )}
      </section>

      <section className="rounded-[var(--radius)] border border-[var(--border)] bg-[var(--surface)] p-4">
        {!selected ? (
          <div className="py-12 text-center text-[13px] text-[var(--fg-muted)]">
            选择左侧文件查看内容{canWrite ? " / 编辑 / 删除" : "（只读）"}。
          </div>
        ) : (
          <div className="flex h-full flex-col">
            <div className="mb-2 flex items-center justify-between gap-2">
              <div className="font-mono text-[13px] text-[var(--fg)]">{selected.path}</div>
              {selected.stat && (
                <div className="text-[11px] text-[var(--fg-subtle)]">
                  {selected.stat.isDirectory ? "目录" : `${selected.stat.size} B`} ·{" "}
                  {new Date(selected.stat.mtime).toLocaleString()}
                </div>
              )}
            </div>
            <textarea
              value={draft}
              onChange={(e) => {
                setDraft(e.target.value);
                setSaved(false);
              }}
              readOnly={!canWrite}
              spellCheck={false}
              className="min-h-[320px] flex-1 resize-y rounded-[var(--radius-sm)] border border-[var(--border)] bg-[var(--bg)] p-3 font-mono text-[12px] text-[var(--fg)] outline-none focus:border-[var(--primary)]"
            />
            {error && <div className="mt-2 text-[12px] text-[var(--danger, #c33)]">{error}</div>}
            {saved && <div className="mt-2 text-[12px] text-[var(--ok)]">已保存。</div>}
            {canWrite && (
              <div className="mt-2 flex justify-end">
                <button
                  type="button"
                  onClick={saveFile}
                  disabled={loading || draft === selected.content}
                  className="rounded-[var(--radius-sm)] bg-[var(--primary)] px-4 py-1.5 text-[13px] text-[var(--accent-fg, #fff)] disabled:opacity-50"
                >
                  {loading ? "处理中…" : "保存"}
                </button>
              </div>
            )}
            {!canWrite && (
              <div className="mt-2 text-[12px] text-[var(--fg-subtle)]">
                只读模式：无 workspace.write 权限。
              </div>
            )}
          </div>
        )}
        {loading && !selected && (
          <div className="py-12 text-center text-[13px] text-[var(--fg-muted)]">加载中…</div>
        )}
      </section>
    </div>
  );
}
