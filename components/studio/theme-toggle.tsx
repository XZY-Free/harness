"use client";

import { useEffect, useState } from "react";

/**
 * P2 修复（12 Studio P2-2）：暗色模式切换按钮。
 *
 * 读写 localStorage "snow-theme"("light" | "dark"),切换 <html> 的 class。
 * 防 FOUC 由 app/layout.tsx 的 inline script 在首帧前完成,本组件首帧
 * useEffect 读真实 class 同步按钮状态(避免 SSR/CSR 不一致)。
 * 无 localStorage 时跟随 prefers-color-scheme(由 inline script 初始化)。
 */

type Theme = "light" | "dark";

function SunIcon({ size = 16 }: { size?: number }) {
  return (
    <svg
      width={size}
      height={size}
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth="2"
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden="true"
    >
      <circle cx="12" cy="12" r="4" />
      <path d="M12 2v2M12 20v2M4.93 4.93l1.41 1.41M17.66 17.66l1.41 1.41M2 12h2M20 12h2M6.34 17.66l-1.41 1.41M19.07 4.93l-1.41 1.41" />
    </svg>
  );
}

function MoonIcon({ size = 16 }: { size?: number }) {
  return (
    <svg
      width={size}
      height={size}
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth="2"
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden="true"
    >
      <path d="M21 12.79A9 9 0 1 1 11.21 3 7 7 0 0 0 21 12.79z" />
    </svg>
  );
}

export function ThemeToggle() {
  const [theme, setTheme] = useState<Theme>("light");
  const [mounted, setMounted] = useState(false);

  useEffect(() => {
    // 读首帧前 inline script 设置的 class 同步状态
    const isDark = document.documentElement.classList.contains("dark");
    setTheme(isDark ? "dark" : "light");
    setMounted(true);
  }, []);

  function toggle() {
    const next: Theme = theme === "dark" ? "light" : "dark";
    setTheme(next);
    const root = document.documentElement;
    root.classList.remove("dark", "light");
    root.classList.add(next);
    try {
      localStorage.setItem("snow-theme", next);
    } catch {
      // localStorage 不可用(隐私模式)→ 仅本次会话生效,忽略
    }
  }

  // 首帧未挂载时渲染占位(避免 hydration mismatch:SSR 不知道客户端主题)
  if (!mounted) {
    return (
      <button
        type="button"
        aria-label="切换主题"
        className="flex size-8 items-center justify-center rounded-[var(--radius-sm)] text-[var(--fg-muted)]"
      >
        <span className="size-4" />
      </button>
    );
  }

  return (
    <button
      type="button"
      onClick={toggle}
      aria-label={theme === "dark" ? "切换到亮色模式" : "切换到暗色模式"}
      title={theme === "dark" ? "切换到亮色模式" : "切换到暗色模式"}
      className="flex size-8 items-center justify-center rounded-[var(--radius-sm)] text-[var(--fg-muted)] transition hover:bg-[var(--surface-2)] hover:text-[var(--fg)]"
    >
      {theme === "dark" ? <SunIcon /> : <MoonIcon />}
    </button>
  );
}
