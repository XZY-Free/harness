"use client";

/**
 * V4 Phase D-1：Markdown 渲染 + 代码块语法高亮（shiki）+ 复制按钮。
 *
 * shiki 用 TextMate grammar + VS Code 主题逐 token 精确着色，精度与视觉现代感优于
 * rehype-highlight/highlight.js 的正则匹配——代码块是「AI 写代码」工具的高频核心展示，
 * 故方案定为必须用 shiki（非备选）。
 *
 * shiki 异步初始化（加载语言 grammar），故 CodeBlock 用 effect 等 highlighter 就绪后
 * codeToHtml 转 HTML；未就绪时先渲染纯文本 fallback，就绪后替换为高亮 HTML。
 * getSingletonHighlighter 模块级单例，全应用共享一份 highlighter（语言按需预加载常用集）。
 */

import { type ReactNode, useEffect, useMemo, useRef, useState } from "react";
import ReactMarkdown from "react-markdown";
import remarkGfm from "remark-gfm";
import { type Highlighter, getSingletonHighlighter } from "shiki";
import { Icon } from "./icons";

/** 预加载的常用语言（覆盖 AI 写代码的主要场景）。未预加载的语言 highlighter 会按需加载。 */
const PRELOAD_LANGS = [
  "javascript",
  "typescript",
  "jsx",
  "tsx",
  "python",
  "sql",
  "bash",
  "json",
  "html",
  "css",
  "yaml",
  "markdown",
] as const;
const THEME = "github-dark";

let highlighterPromise: Promise<Highlighter> | null = null;

/** 模块级单例 highlighter：首次调用加载预置语言 + 主题，后续共享。 */
function getHighlighter(): Promise<Highlighter> {
  if (!highlighterPromise) {
    highlighterPromise = getSingletonHighlighter({
      themes: [THEME],
      langs: [...PRELOAD_LANGS],
    });
  }
  return highlighterPromise;
}

/** 从 code 元素 className 提取语言（react-markdown 给的 language-xxx）。 */
function langFromClassName(className?: string): string | null {
  const m = /language-(\w+)/.exec(className ?? "");
  return m ? (m[1] ?? null) : null;
}

/** 从 ReactNode children 提取纯文本（复制 + shiki 输入用）。 */
function extractText(node: ReactNode): string {
  if (typeof node === "string") return node;
  if (typeof node === "number") return String(node);
  if (Array.isArray(node)) return node.map(extractText).join("");
  if (node && typeof node === "object" && "props" in node) {
    // biome-ignore lint/suspicious/noExplicitAny: React element props 动态访问
    return extractText((node as any).props?.children);
  }
  return "";
}

/** 块级代码块：shiki 高亮 + 复制按钮 + 语言标签。 */
function CodeBlock({ className, children }: { className?: string; children?: ReactNode }) {
  const [copied, setCopied] = useState(false);
  const [html, setHtml] = useState<string | null>(null);
  const lang = langFromClassName(className);
  const codeText = useMemo(() => extractText(children), [children]);

  // shiki 异步：highlighter 就绪后 codeToHtml 生成高亮 HTML。未就绪时 html=null 走纯文本 fallback。
  // 用 ref 记录上一次实际发起过高亮请求的 codeText+lang，避免 Strict Mode 或父组件重渲染导致重复 setState。
  const requestedRef = useRef<{ codeText: string; lang: string | null } | null>(null);
  useEffect(() => {
    const prev = requestedRef.current;
    if (prev && prev.codeText === codeText && prev.lang === lang) return;
    requestedRef.current = { codeText, lang };

    let cancelled = false;
    getHighlighter()
      .then((hl) => {
        if (cancelled) return;
        // lang 未预加载时 getSingletonHighlighter 内部按需加载；try 防未知语言抛错
        try {
          setHtml(
            hl.codeToHtml(codeText, {
              lang: lang ?? "text",
              theme: THEME,
            }),
          );
        } catch {
          setHtml(null); // 未知语言 → fallback 纯文本
        }
      })
      .catch(() => {
        // highlighter 初始化失败 → fallback 纯文本（不阻塞阅读）
      });
    return () => {
      cancelled = true;
    };
  }, [codeText, lang]);

  async function copy() {
    try {
      await navigator.clipboard.writeText(codeText);
      setCopied(true);
      setTimeout(() => setCopied(false), 1500);
    } catch {
      // 剪贴板不可用（非 HTTPS / 权限拒绝），静默
    }
  }

  return (
    <div className="group relative my-3">
      {/* 语言标签 */}
      {lang ? (
        <span className="absolute right-12 top-2 z-10 text-[11px] text-[var(--fg-subtle)]">
          {lang}
        </span>
      ) : null}
      {/* 复制按钮 */}
      <button
        type="button"
        onClick={copy}
        className="absolute right-2 top-2 z-10 flex size-6 items-center justify-center rounded text-[var(--fg-subtle)] opacity-0 transition hover:bg-[var(--surface-2)] hover:text-[var(--fg)] group-hover:opacity-100"
        title="复制代码"
        aria-label="复制代码"
      >
        <Icon.copy size={13} />
      </button>
      {/* shiki 高亮 HTML（已含 github-dark 主题着色）；未就绪时纯文本 fallback */}
      {html ? (
        <div
          className="shiki-block overflow-x-auto rounded-[var(--radius-md)] text-[13px] leading-6"
          // biome-ignore lint/security/noDangerouslySetInnerHtml: shiki codeToHtml 输出受信任的语法高亮 HTML
          dangerouslySetInnerHTML={{ __html: html }}
        />
      ) : (
        <pre className="overflow-x-auto rounded-[var(--radius-md)] bg-[var(--surface-2)] p-3 text-[13px] leading-6">
          <code className={`${className ?? ""} bg-transparent p-0 text-inherit text-[13px]`}>
            {children}
          </code>
        </pre>
      )}
      {copied ? (
        <span className="absolute right-2 top-9 z-10 text-[11px] text-[var(--ok)]">已复制</span>
      ) : null}
    </div>
  );
}

/** react-markdown 块级 pre 渲染器：从 <code> 元素提取 className/children 交给 CodeBlock。 */
function PreRenderer({ children }: { children?: ReactNode }) {
  // biome-ignore lint/suspicious/noExplicitAny: react-markdown pre props 动态
  const codeEl = children as any;
  const codeProps = codeEl?.props ?? {};
  return <CodeBlock className={codeProps.className}>{codeProps.children}</CodeBlock>;
}

/** react-markdown 行内 code 渲染器。块级 code 已被 pre 覆盖，这里只处理行内 code。 */
function InlineCodeRenderer({
  className,
  children,
  ...rest
}: {
  className?: string;
  children?: ReactNode;
}) {
  return (
    <code
      className={`${className ?? ""} rounded bg-[var(--surface-2)] px-1 py-0.5 text-[13px]`}
      {...rest}
    >
      {children}
    </code>
  );
}

// 组件引用必须在渲染间保持稳定；若把 renderers 定义在 Markdown 内部，
// 每次渲染都会生成新的函数引用，导致 React 不断 unmount/remount CodeBlock，
// 配合 shiki 异步 setState 会触发 Maximum update depth exceeded。
const MARKDOWN_COMPONENTS = {
  pre: PreRenderer,
  code: InlineCodeRenderer,
};

export function Markdown({ children }: { children: string }) {
  return (
    <ReactMarkdown remarkPlugins={[remarkGfm]} components={MARKDOWN_COMPONENTS}>
      {children}
    </ReactMarkdown>
  );
}
