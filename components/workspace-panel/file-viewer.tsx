"use client";

import { Markdown } from "@/components/markdown";
import { apiPath } from "@/lib/api-fetch";
import { useEffect, useState } from "react";

/**
 * V5-B2：工作区文件查看器。
 *
 * 按文件扩展名分流渲染：
 * - Markdown (.md/.markdown) → 复用 Markdown 组件（react-markdown + shiki 代码块）
 * - HTML (.html/.htm) → 按源码文本展示；运行效果只在独立 preview 视图中渲染
 * - 图片 (.png/.jpg/.jpeg/.gif/.webp/.svg/.avif/.bmp/.ico) → <img> 走 raw=1 端点
 * - PDF (.pdf) → <iframe> 走 raw=1 端点（浏览器内置 viewer）
 * - 字体 (.woff/.woff2/.ttf/.otf) → 文件类型提示（不预览字形，非本场景）
 * - 其它文本 / 代码 → <pre> 渲染原文，行号留待后续；当前不引额外依赖
 *
 * 安全：
 * - 文件视图不执行 HTML，避免把“查看源码”和“运行预览”混为一谈。
 * - 图片 / PDF 走同源 raw=1 端点，由正式 v1 workspace 路由 owner 鉴权保护。
 */
type FileKind = "markdown" | "html" | "image" | "pdf" | "font" | "text";

function extOf(path: string): string {
  const idx = path.lastIndexOf(".");
  return idx < 0 ? "" : path.slice(idx).toLowerCase();
}

function kindForPath(path: string): FileKind {
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
  return "text";
}

/** 二进制资源（图片 / PDF）走 raw=1 端点，按 threadId + path 拼装。 */
export function rawUrl(threadId: string, path: string): string {
  return apiPath(
    `/api/v1/threads/${threadId}/workspace/${path.split("/").map(encodeURIComponent).join("/")}?raw=1`,
  );
}

type ContentState =
  | { status: "loading" }
  | { status: "error"; message: string }
  | { status: "ok"; content: string; truncated?: boolean }
  | { status: "too_large"; message: string };

/** V6-M3-7: 大文件截断阈值 (1MB) */
const MAX_PREVIEW_SIZE = 1024 * 1024;

/** V6-M3-7: 二进制文件扩展名（不可预览） */
const BINARY_EXTS = new Set([
  ".zip",
  ".tar",
  ".gz",
  ".bz2",
  ".xz",
  ".7z",
  ".rar",
  ".exe",
  ".dll",
  ".so",
  ".dylib",
  ".bin",
  ".dat",
  ".class",
  ".pyc",
  ".o",
  ".a",
]);

function isBinaryPath(path: string): boolean {
  const ext = extOf(path);
  return BINARY_EXTS.has(ext);
}

export function FileViewer({ threadId, path }: { threadId: string; path: string }) {
  const kind = kindForPath(path);
  const [state, setState] = useState<ContentState>({ status: "loading" });

  // 文本类（包括 HTML 源码）拉取 JSON 信封内容；图片 / PDF 才走 raw=1。
  const isTextLike = kind === "markdown" || kind === "html" || kind === "text" || kind === "font";

  useEffect(() => {
    if (!isTextLike) return;
    let cancelled = false;
    setState({ status: "loading" });
    fetch(rawFetchUrl(threadId, path))
      .then((r) => {
        if (!r.ok) {
          // 404 / 403 / 400 都映射为可读的错误（不暴露后端 code 细节）
          throw new Error(r.status === 404 ? "文件不存在" : "无法加载文件");
        }
        return r.json();
      })
      .then((json: { ok?: boolean; data?: { content: string | null; too_large?: boolean } }) => {
        if (cancelled) return;
        // X43 修复：服务端返回 too_large 时不传 content，前端展示只读提示
        if (json.ok && json.data?.too_large) {
          setState({ status: "too_large", message: "文件过大（超过 1MB），仅支持下载查看" });
          return;
        }
        if (json.ok && json.data && typeof json.data.content === "string") {
          const content = json.data.content;
          setState({ status: "ok", content, truncated: false });
        } else {
          setState({ status: "error", message: "无法加载文件" });
        }
      })
      .catch((err: unknown) => {
        if (cancelled) return;
        const msg = err instanceof Error ? err.message : "无法加载文件";
        setState({ status: "error", message: msg });
      });
    return () => {
      cancelled = true;
    };
  }, [threadId, path, isTextLike]);

  if (kind === "image") {
    return (
      <div className="flex min-h-0 flex-1 items-center justify-center overflow-auto bg-[var(--surface-2)] p-4">
        {/* 工作区 raw 资源（按 threadId + path 动态拼装），不能走 next/image 静态优化。
            alt 用文件名兜底，避免 lint 报必填项缺失。 */}
        <img
          src={rawUrl(threadId, path)}
          alt={path.split("/").pop() ?? ""}
          className="max-h-full max-w-full object-contain"
        />
      </div>
    );
  }

  if (kind === "pdf") {
    return (
      <div className="relative min-h-0 flex-1 bg-[var(--surface-2)]">
        <iframe
          src={rawUrl(threadId, path)}
          title={path}
          className="h-full w-full border-0 bg-white"
        />
      </div>
    );
  }

  if (kind === "font") {
    return (
      <div className="flex min-h-0 flex-1 items-center justify-center px-6 text-center text-[13px] text-[var(--fg-muted)]">
        字体文件不预览字形，可下载查看。
      </div>
    );
  }

  // V6-M3-7: 二进制文件兜底
  if (isBinaryPath(path)) {
    return (
      <div className="flex min-h-0 flex-1 items-center justify-center px-6 text-center text-[13px] text-[var(--fg-muted)]">
        二进制文件不可预览，可下载查看。
      </div>
    );
  }

  if (state.status === "loading") {
    return (
      <div className="flex min-h-0 flex-1 items-center justify-center px-6 text-[13px] text-[var(--fg-subtle)]">
        加载中…
      </div>
    );
  }

  if (state.status === "error") {
    return (
      <div className="flex min-h-0 flex-1 items-center justify-center px-6 text-center text-[13px] text-[var(--danger)]">
        {state.message}
      </div>
    );
  }

  // X43 修复：服务端判定 too_large 时展示只读提示
  if (state.status === "too_large") {
    return (
      <div className="flex min-h-0 flex-1 items-center justify-center px-6 text-center text-[13px] text-[var(--fg-muted)]">
        {state.message}
      </div>
    );
  }

  if (kind === "markdown") {
    return (
      <div className="min-h-0 flex-1 overflow-y-auto bg-[var(--surface)] px-6 py-4">
        {state.truncated && (
          <div className="mb-4 rounded-md bg-amber-50 p-3 text-sm text-amber-800 dark:bg-amber-900/20 dark:text-amber-200">
            文件过大，仅显示前 1MB 内容
          </div>
        )}
        <Markdown>{state.content}</Markdown>
      </div>
    );
  }

  // HTML / text / 代码：文件视图一律显示原文，不执行内容。
  return (
    <div className="min-h-0 flex-1 overflow-auto bg-[var(--surface)]">
      {state.truncated && (
        <div className="m-4 rounded-md bg-amber-50 p-3 text-sm text-amber-800 dark:bg-amber-900/20 dark:text-amber-200">
          文件过大，仅显示前 1MB 内容
        </div>
      )}
      <pre className="p-4 text-[12.5px] leading-5 text-[var(--fg)]">
        <code>{state.content}</code>
      </pre>
    </div>
  );
}

/** JSON 信封端点 URL（非 raw=1）。encodeURIComponent 已对 path 各段做处理。 */
function rawFetchUrl(threadId: string, path: string): string {
  return apiPath(
    `/api/v1/threads/${threadId}/workspace/${path.split("/").map(encodeURIComponent).join("/")}`,
  );
}
