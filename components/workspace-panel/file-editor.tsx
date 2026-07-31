"use client";

/**
 * V9 阶段 4：可编辑代码编辑器。
 *
 * - 文本类文件（代码 / 文本 / Markdown 源码）走 textarea + 行号
 * - 图片 / PDF / 字体 / 二进制：不可编辑，回退到只读 FileViewer 提示
 * - 自动保存：停止输入 1s 后静默保存（带 revision，防丢改动）
 * - Cmd/Ctrl+S：立即保存
 * - 冲突检测：保存返回 409 → 展示 diff/merge，不静默覆盖用户编辑
 *
 * 安全：
 * - 编辑器只发送文本内容到 PUT 端点；revision 由服务端校验，不静默覆盖
 * - HTML 在编辑器中以源码形式呈现，不执行（运行效果在浏览器页签）
 */
import { Icon } from "@/components/icons";
import { apiPath } from "@/lib/api-fetch";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { FileViewer } from "./file-viewer";

const AUTOSAVE_DELAY_MS = 1000;
const MAX_EDITABLE_SIZE = 1024 * 1024; // 1MB 以上不进入编辑态

type EditableKind = "markdown" | "html" | "text";
type NonEditableKind = "image" | "pdf" | "font" | "binary";

function extOf(path: string): string {
  const idx = path.lastIndexOf(".");
  return idx < 0 ? "" : path.slice(idx).toLowerCase();
}

function classifyPath(path: string): EditableKind | NonEditableKind {
  const ext = extOf(path);
  if (ext === ".md" || ext === ".markdown") return "markdown";
  if (ext === ".html" || ext === ".htm") return "html";
  if (
    ext === ".png" ||
    ext === ".jpg" ||
    ext === ".jpeg" ||
    ext === ".gif" ||
    ext === ".webp" ||
    ext === ".svg" ||
    ext === ".avif" ||
    ext === ".bmp" ||
    ext === ".ico"
  ) {
    return "image";
  }
  if (ext === ".pdf") return "pdf";
  if (ext === ".woff" || ext === ".woff2" || ext === ".ttf" || ext === ".otf" || ext === ".eot") {
    return "font";
  }
  if (
    ext === ".zip" ||
    ext === ".tar" ||
    ext === ".gz" ||
    ext === ".bz2" ||
    ext === ".xz" ||
    ext === ".7z" ||
    ext === ".rar" ||
    ext === ".exe" ||
    ext === ".dll" ||
    ext === ".so" ||
    ext === ".dylib" ||
    ext === ".bin" ||
    ext === ".dat" ||
    ext === ".class" ||
    ext === ".pyc" ||
    ext === ".o" ||
    ext === ".a"
  ) {
    return "binary";
  }
  return "text";
}

type LoadState =
  | { status: "loading" }
  | { status: "error"; message: string }
  | { status: "ok"; content: string; revision: string; truncated?: boolean }
  | { status: "too_large"; message: string };

type SaveState =
  | { status: "idle" }
  | { status: "saving" }
  | { status: "saved" }
  | { status: "error"; message: string }
  | { status: "conflict"; remoteRevision: string; remoteContent: string };

function fetchUrl(threadId: string, path: string): string {
  return apiPath(
    `/api/threads/${threadId}/workspace/${path.split("/").map(encodeURIComponent).join("/")}`,
  );
}

export function FileEditor({ threadId, path }: { threadId: string; path: string }) {
  const kind = classifyPath(path);

  // 非文本类回退到只读 FileViewer
  if (kind === "image" || kind === "pdf" || kind === "font" || kind === "binary") {
    return <FileViewer threadId={threadId} path={path} />;
  }

  return <EditableArea threadId={threadId} path={path} kind={kind} />;
}

function EditableArea({
  threadId,
  path,
  kind,
}: {
  threadId: string;
  path: string;
  kind: EditableKind;
}) {
  const [load, setLoad] = useState<LoadState>({ status: "loading" });
  // 本地编辑值：初始为已加载内容，用户输入后偏离服务端基线
  const [draft, setDraft] = useState<string>("");
  // 已加载的服务端基线内容与 revision（保存时回传 revision）
  const baseRef = useRef<{ content: string; revision: string }>({ content: "", revision: "" });
  const [save, setSave] = useState<SaveState>({ status: "idle" });
  const autosaveTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const textareaRef = useRef<HTMLTextAreaElement>(null);

  // 加载文件内容 + revision
  useEffect(() => {
    let cancelled = false;
    setLoad({ status: "loading" });
    setSave({ status: "idle" });
    fetch(fetchUrl(threadId, path))
      .then((r) => {
        if (!r.ok) throw new Error(r.status === 404 ? "文件不存在" : "无法加载文件");
        return r.json();
      })
      .then(
        (json: {
          ok?: boolean;
          data?: { content: string | null; stat?: { revision?: string }; too_large?: boolean };
        }) => {
          if (cancelled) return;
          // X42 修复：服务端返回 too_large 时不传 content，前端直接展示只读提示
          if (json.ok && json.data?.too_large) {
            setLoad({ status: "too_large", message: "文件过大（超过 1MB），不可编辑，请下载查看" });
            return;
          }
          if (json.ok && json.data && typeof json.data.content === "string") {
            const content = json.data.content;
            const revision = json.data.stat?.revision ?? "";
            setLoad({ status: "ok", content, revision });
            setDraft(content);
            baseRef.current = { content, revision };
          } else {
            setLoad({ status: "error", message: "无法加载文件" });
          }
        },
      )
      .catch((err: unknown) => {
        if (cancelled) return;
        const msg = err instanceof Error ? err.message : "无法加载文件";
        setLoad({ status: "error", message: msg });
      });
    return () => {
      cancelled = true;
    };
  }, [threadId, path]);

  const doSave = useCallback(
    async (opts: { immediate?: boolean; force?: boolean } = {}) => {
      const base = baseRef.current;
      // 无改动不保存
      if (draft === base.content) {
        if (opts.immediate) setSave({ status: "saved" });
        return;
      }
      // 冲突态：不自动保存（需用户决定 merge）。X41 修复：force=true 时绕过（用户已选择保留本地）
      if (save.status === "conflict" && !opts.force) return;
      setSave({ status: "saving" });
      try {
        const res = await fetch(fetchUrl(threadId, path), {
          method: "PUT",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ content: draft, revision: base.revision }),
        });
        if (res.status === 409) {
          const body = await res.json();
          const remoteRevision: string = body?.error?.currentRevision ?? "";
          const remoteContent: string = body?.error?.currentContent ?? "";
          setSave({
            status: "conflict",
            remoteRevision,
            remoteContent,
          });
          return;
        }
        if (!res.ok) {
          const msg = res.status === 403 ? "无写入权限" : "保存失败";
          setSave({ status: "error", message: msg });
          return;
        }
        const body = await res.json();
        const newRevision: string = body?.data?.stat?.revision ?? "";
        // 更新基线为已保存内容 + 新 revision
        baseRef.current = { content: draft, revision: newRevision };
        setSave({ status: "saved" });
      } catch {
        setSave({ status: "error", message: "网络错误，保存失败" });
      }
    },
    [draft, path, save.status, threadId],
  );

  // 自动保存：draft 变化后 1s 静默保存（仅当有改动且非冲突态）
  useEffect(() => {
    if (autosaveTimer.current) {
      clearTimeout(autosaveTimer.current);
      autosaveTimer.current = null;
    }
    if (load.status !== "ok" || load.truncated) return;
    if (draft === baseRef.current.content) return;
    if (save.status === "conflict" || save.status === "saving") return;
    autosaveTimer.current = setTimeout(() => {
      void doSave();
    }, AUTOSAVE_DELAY_MS);
    return () => {
      if (autosaveTimer.current) {
        clearTimeout(autosaveTimer.current);
        autosaveTimer.current = null;
      }
    };
  }, [draft, load, save.status, doSave]);

  // Cmd/Ctrl+S：立即保存
  useEffect(() => {
    function onKey(e: KeyboardEvent) {
      if ((e.metaKey || e.ctrlKey) && e.key === "s") {
        e.preventDefault();
        if (autosaveTimer.current) {
          clearTimeout(autosaveTimer.current);
          autosaveTimer.current = null;
        }
        void doSave({ immediate: true });
      }
    }
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [doSave]);

  const isDirty = load.status === "ok" && !load.truncated && draft !== baseRef.current.content;

  // 冲突 merge：用户选择保留远端 / 保留本地 / 手动编辑
  const handleTakeRemote = useCallback(() => {
    if (save.status !== "conflict") return;
    setDraft(save.remoteContent);
    baseRef.current = {
      content: save.remoteContent,
      revision: save.remoteRevision,
    };
    setSave({ status: "saved" });
  }, [save]);

  const handleKeepLocal = useCallback(async () => {
    if (save.status !== "conflict") return;
    // X41 修复：以远端 revision 为基线，重新提交本地草稿。
    // 使用 force=true 绕过 doSave 闭包中捕获的旧 save.status==="conflict" 检查，
    // 否则 doSave 会直接 return 不保存。
    baseRef.current = {
      content: save.remoteContent,
      revision: save.remoteRevision,
    };
    setSave({ status: "idle" });
    // 立即重新保存本地草稿（force 绕过冲突检查）
    await doSave({ force: true });
  }, [save, doSave]);

  const lineCount = useMemo(() => draft.split("\n").length, [draft]);

  if (load.status === "loading") {
    return (
      <div className="flex min-h-0 flex-1 items-center justify-center px-6 text-[13px] text-[var(--fg-subtle)]">
        加载中…
      </div>
    );
  }
  if (load.status === "error") {
    return (
      <div className="flex min-h-0 flex-1 items-center justify-center px-6 text-center text-[13px] text-[var(--danger)]">
        {load.message}
      </div>
    );
  }
  // X42 修复：服务端判定 too_large 时不进入编辑态，回退只读查看器
  if (load.status === "too_large") {
    return (
      <div className="flex min-h-0 flex-1 items-center justify-center px-6 text-center text-[13px] text-[var(--fg-muted)]">
        {load.message}
      </div>
    );
  }
  if (load.truncated) {
    // 超大文件回退只读
    return <FileViewer threadId={threadId} path={path} />;
  }

  return (
    <div className="flex min-h-0 flex-1 flex-col">
      {/* 编辑器状态栏 */}
      <div className="flex shrink-0 items-center justify-between gap-2 border-[var(--border)] border-b bg-[var(--surface)] px-3 py-1.5">
        <div className="flex items-center gap-2 text-[11px] text-[var(--fg-subtle)]">
          <SaveBadge save={save} isDirty={isDirty} />
          {kind === "markdown" && <span>Markdown 源码</span>}
          {kind === "html" && <span>HTML 源码（不执行）</span>}
        </div>
        <span className="font-mono text-[11px] text-[var(--fg-subtle)]">{lineCount} 行</span>
      </div>

      {/* 冲突面板 */}
      {save.status === "conflict" && (
        <ConflictBar
          remoteContent={save.remoteContent}
          localDraft={draft}
          onTakeRemote={handleTakeRemote}
          onKeepLocal={handleKeepLocal}
        />
      )}

      {/* 编辑区：行号 + textarea */}
      <div className="flex min-h-0 flex-1 overflow-hidden bg-[var(--surface)]">
        <LineNumbers content={draft} />
        <textarea
          ref={textareaRef}
          value={draft}
          onChange={(e) => setDraft(e.target.value)}
          spellCheck={false}
          className="flex-1 resize-none border-0 bg-transparent px-3 py-3 font-mono text-[12.5px] leading-5 text-[var(--fg)] outline-none"
          placeholder="// 文件内容为空"
        />
      </div>
    </div>
  );
}

function SaveBadge({ save, isDirty }: { save: SaveState; isDirty: boolean }) {
  if (save.status === "saving") {
    return (
      <span className="flex items-center gap-1 text-[var(--primary)]">
        <Icon.spinner size={12} className="animate-spin" />
        保存中…
      </span>
    );
  }
  if (save.status === "saved") {
    return (
      <span className="flex items-center gap-1 text-[var(--fg-subtle)]">
        <Icon.check size={12} />
        已保存
      </span>
    );
  }
  if (save.status === "error") {
    return (
      <span className="flex items-center gap-1 text-[var(--danger)]">
        <Icon.warn size={12} />
        {save.message}
      </span>
    );
  }
  if (save.status === "conflict") {
    return (
      <span className="flex items-center gap-1 text-[var(--danger)]">
        <Icon.warn size={12} />
        文件已被修改，需合并
      </span>
    );
  }
  return (
    <span className={isDirty ? "text-[var(--fg-muted)]" : "text-[var(--fg-subtle)]"}>
      {isDirty ? "● 有未保存改动" : "自动保存已开启"}
    </span>
  );
}

function LineNumbers({ content }: { content: string }) {
  const lines = content.split("\n");
  return (
    <div
      className="select-none overflow-hidden border-r border-[var(--border)] bg-[var(--surface-2)] px-2 py-3 text-right font-mono text-[11px] leading-5 text-[var(--fg-subtle)]"
      aria-hidden="true"
    >
      {lines.map((_, i) => (
        <div key={i}>{i + 1}</div>
      ))}
    </div>
  );
}

function ConflictBar({
  remoteContent,
  localDraft,
  onTakeRemote,
  onKeepLocal,
}: {
  remoteContent: string;
  localDraft: string;
  onTakeRemote: () => void;
  onKeepLocal: () => void;
}) {
  // 简易行级 diff：标记本地独有 / 远端独有的行
  const remoteLines = remoteContent.split("\n");
  const localLines = localDraft.split("\n");

  return (
    <div className="shrink-0 border-b border-[var(--border)] bg-amber-50 px-3 py-2 dark:bg-amber-900/10">
      <div className="mb-2 flex items-center gap-2 text-[12px] text-amber-800 dark:text-amber-200">
        <Icon.warn size={13} />
        <span className="font-medium">文件已被外部修改（AI 或其他来源）</span>
      </div>
      <div className="mb-2 max-h-[180px] overflow-auto rounded border border-[var(--border)] bg-[var(--surface)] p-2 font-mono text-[11px] leading-5">
        <DiffView remoteLines={remoteLines} localLines={localLines} />
      </div>
      <div className="flex gap-2">
        <button
          type="button"
          onClick={onTakeRemote}
          className="rounded border border-[var(--border)] px-2.5 py-1 text-[12px] text-[var(--fg-muted)] transition hover:border-[var(--border-strong)] hover:text-[var(--fg)]"
        >
          采用远端版本
        </button>
        <button
          type="button"
          onClick={onKeepLocal}
          className="rounded border border-[var(--primary)] px-2.5 py-1 text-[12px] text-[var(--primary)] transition hover:bg-[var(--primary)]/10"
        >
          保留我的改动并重新保存
        </button>
      </div>
    </div>
  );
}

function DiffView({
  remoteLines,
  localLines,
}: {
  remoteLines: string[];
  localLines: string[];
}) {
  // 简易 LCS 行级 diff：找出共有行，标记独有行
  const maxLen = Math.max(remoteLines.length, localLines.length);
  const rows: Array<{ kind: "same" | "remote" | "local"; remote?: string; local?: string }> = [];
  for (let i = 0; i < maxLen; i++) {
    const r = remoteLines[i];
    const l = localLines[i];
    if (r === l) {
      rows.push({ kind: "same", remote: r, local: l });
    } else {
      if (r !== undefined) rows.push({ kind: "remote", remote: r });
      if (l !== undefined) rows.push({ kind: "local", local: l });
    }
  }
  return (
    <div>
      {rows.map((row, i) => {
        if (row.kind === "same") {
          return (
            <div key={i} className="text-[var(--fg-subtle)]">
              <span className="mr-2 select-none"> </span>
              {row.remote}
            </div>
          );
        }
        if (row.kind === "remote") {
          return (
            <div key={i} className="bg-red-50 text-red-700 dark:bg-red-900/20 dark:text-red-300">
              <span className="mr-2 select-none">-</span>
              {row.remote}
            </div>
          );
        }
        return (
          <div
            key={i}
            className="bg-green-50 text-green-700 dark:bg-green-900/20 dark:text-green-300"
          >
            <span className="mr-2 select-none">+</span>
            {row.local}
          </div>
        );
      })}
    </div>
  );
}
