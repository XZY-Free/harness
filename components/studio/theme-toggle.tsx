"use client";

import { Button } from "@/components/ui/button";
import { Moon, Sun } from "lucide-react";
import { useEffect, useState } from "react";

type Theme = "light" | "dark";

/**
 * Studio 独立主题切换。首屏主题由 theme-init.js 在 hydration 前写入，组件只同步状态。
 */
export function ThemeToggle() {
  const [theme, setTheme] = useState<Theme>("light");
  const [mounted, setMounted] = useState(false);

  useEffect(() => {
    setTheme(document.documentElement.classList.contains("dark") ? "dark" : "light");
    setMounted(true);
  }, []);

  function toggle() {
    const next: Theme = theme === "dark" ? "light" : "dark";
    const root = document.documentElement;

    setTheme(next);
    root.classList.remove("dark", "light");
    root.classList.add(next);
    try {
      localStorage.setItem("snow-theme", next);
    } catch {
      // 无法持久化时仍保留当前页面的主题选择。
    }
  }

  const actionLabel = theme === "dark" ? "切换到亮色模式" : "切换到暗色模式";

  return (
    <Button
      type="button"
      variant="ghost"
      onClick={mounted ? toggle : undefined}
      aria-label={mounted ? actionLabel : "切换主题"}
      title={mounted ? actionLabel : undefined}
      className="w-full justify-start px-2 text-sidebar-foreground/75 hover:bg-sidebar-accent hover:text-sidebar-accent-foreground"
    >
      {mounted && theme === "dark" ? <Sun aria-hidden="true" /> : <Moon aria-hidden="true" />}
      <span>外观</span>
      <span className="ml-auto text-xs text-muted-foreground">
        {mounted ? (theme === "dark" ? "暗色" : "亮色") : ""}
      </span>
    </Button>
  );
}
