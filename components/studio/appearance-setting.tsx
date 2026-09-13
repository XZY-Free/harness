"use client";

import { cn } from "@/lib/utils";
import { useEffect, useState } from "react";

/**
 * 平台设置 → 外观（侧栏改版 v3：主题从导航槽位迁回设置）。
 *
 * - 三态：跟随系统 / 亮色 / 暗色；显式选择写入 localStorage `snow-theme`，
 *   `跟随系统` 写入 "system"，theme-init.js 视同未保存并回落到系统偏好。
 * - 跟随系统时监听 prefers-color-scheme 变化实时生效。
 * - 首屏主题仍由 theme-init.js 在 hydration 前写入，本组件只同步与切换。
 */

const THEME_STORAGE_KEY = "snow-theme";

type ThemeChoice = "system" | "light" | "dark";

const CHOICES: readonly { readonly value: ThemeChoice; readonly label: string }[] = [
  { value: "system", label: "跟随系统" },
  { value: "light", label: "亮色" },
  { value: "dark", label: "暗色" },
];

function systemTheme(): "light" | "dark" {
  return window.matchMedia("(prefers-color-scheme: dark)").matches ? "dark" : "light";
}

function readChoice(): ThemeChoice {
  try {
    const stored = localStorage.getItem(THEME_STORAGE_KEY);
    return stored === "light" || stored === "dark" ? stored : "system";
  } catch {
    return "system";
  }
}

function applyChoice(choice: ThemeChoice): void {
  const effective = choice === "system" ? systemTheme() : choice;
  const root = document.documentElement;
  root.classList.remove("dark", "light");
  root.classList.add(effective);
}

export function AppearanceSetting() {
  const [choice, setChoice] = useState<ThemeChoice>("system");
  const [mounted, setMounted] = useState(false);

  useEffect(() => {
    setChoice(readChoice());
    setMounted(true);

    const media = window.matchMedia("(prefers-color-scheme: dark)");
    const onSystemChange = () => {
      if (readChoice() === "system") applyChoice("system");
    };
    media.addEventListener("change", onSystemChange);
    return () => media.removeEventListener("change", onSystemChange);
  }, []);

  function select(next: ThemeChoice) {
    setChoice(next);
    try {
      localStorage.setItem(THEME_STORAGE_KEY, next);
    } catch {
      // 无法持久化时仍保留当前会话的主题选择。
    }
    applyChoice(next);
  }

  return (
    <fieldset
      aria-label="主题"
      className="inline-flex min-w-0 gap-0.5 rounded-lg border border-border bg-muted p-0.5"
    >
      {CHOICES.map((item) => (
        <button
          key={item.value}
          type="button"
          aria-pressed={mounted && choice === item.value}
          disabled={!mounted}
          onClick={() => select(item.value)}
          className={cn(
            "rounded-md px-2.5 py-1 text-xs outline-none transition-colors focus-visible:ring-2 focus-visible:ring-ring",
            mounted && choice === item.value
              ? "bg-background font-medium text-foreground shadow-xs"
              : "text-muted-foreground hover:text-foreground",
          )}
        >
          {item.label}
        </button>
      ))}
    </fieldset>
  );
}
