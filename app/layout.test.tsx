import { readFileSync } from "node:fs";
import { join } from "node:path";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it, vi } from "vitest";

vi.mock("@/components/brand/brand-initial", () => ({
  BrandInitial: ({ children }: { children: React.ReactNode }) => <>{children}</>,
}));

vi.mock("next/script", () => ({
  default: ({
    strategy: _strategy,
    ...props
  }: React.ComponentPropsWithoutRef<"script"> & { strategy?: string }) => <script {...props} />,
}));

import RootLayout from "./layout";

function renderLayoutMarkup(): string {
  return renderToStaticMarkup(
    <RootLayout>
      <div>content</div>
    </RootLayout>,
  );
}

function extractThemeInitScript(): string {
  const markup = renderLayoutMarkup();
  expect(markup).toMatch(/<script[^>]*id="theme-init"[^>]*src="\/theme-init\.js"[^>]*><\/script>/);
  return readFileSync(join(process.cwd(), "public/theme-init.js"), "utf8");
}

function runThemeInit(
  pathname: string,
  storedTheme: string | null,
  prefersDark: boolean,
): string[] {
  const added: string[] = [];
  const script = extractThemeInitScript();
  const localStorage = {
    getItem: vi.fn(() => storedTheme),
  };
  const window = {
    location: { pathname },
    matchMedia: vi.fn(() => ({ matches: prefersDark })),
  };
  const document = {
    documentElement: {
      classList: {
        add: (theme: string) => added.push(theme),
        remove: () => {},
      },
    },
  };

  new Function("localStorage", "window", "document", script)(localStorage, window, document);
  return added;
}

describe("themeInitScript", () => {
  it("未挂载设置页时，系统变化仍更新 Studio 主题；显式选择优先", () => {
    let stored: string | null = "system";
    const media = {
      matches: false,
      addEventListener: vi.fn<(name: string, callback: () => void) => void>(),
    };
    const classes = new Set<string>();
    new Function("localStorage", "window", "document", extractThemeInitScript())(
      { getItem: () => stored },
      { location: { pathname: "/studio/agents" }, matchMedia: () => media },
      {
        documentElement: {
          classList: {
            add: (v: string) => classes.add(v),
            remove: (...vs: string[]) => {
              for (const v of vs) classes.delete(v);
            },
          },
        },
      },
    );
    expect(media.addEventListener).toHaveBeenCalledWith("change", expect.any(Function));
    const onChange = media.addEventListener.mock.calls[0]?.[1];
    if (!onChange) throw new Error("缺少系统主题监听");
    media.matches = true;
    onChange();
    expect([...classes]).toEqual(["dark"]);
    stored = "light";
    onChange();
    expect([...classes]).toEqual(["light"]);
  });

  it("子路径部署时从 basePath 加载主题初始化脚本", () => {
    vi.stubEnv("NEXT_PUBLIC_SNOW_BASE_PATH", "/snowharness");
    try {
      const markup = renderLayoutMarkup();
      expect(markup).toMatch(
        /<script[^>]*id="theme-init"[^>]*src="\/snowharness\/theme-init\.js"[^>]*><\/script>/,
      );
    } finally {
      vi.unstubAllEnvs();
    }
  });

  it("员工 Web 与 Desktop 没有保存主题时都默认使用浅色", () => {
    expect(runThemeInit("/desktop/chat/thread-1", null, true)).toEqual(["light"]);
    expect(runThemeInit("/chat/new", null, true)).toEqual(["light"]);
  });

  it("登录与首次设密等认证前页面强制浅色，不跟随系统暗色或保存主题", () => {
    expect(runThemeInit("/login", null, true)).toEqual(["light"]);
    expect(runThemeInit("/setup-password", "dark", true)).toEqual(["light"]);
  });

  it("Studio 保存的暗色选择不污染员工 Web 与 Desktop", () => {
    expect(runThemeInit("/desktop/chat/thread-1", "dark", false)).toEqual(["light"]);
    expect(runThemeInit("/chat/new", "dark", false)).toEqual(["light"]);
  });

  it("Studio 没有保存主题时跟随系统深浅色", () => {
    expect(runThemeInit("/studio", null, true)).toEqual(["dark"]);
    expect(runThemeInit("/studio", null, false)).toEqual(["light"]);
  });

  it("Studio 保存跟随系统（system）时同样回落系统偏好", () => {
    expect(runThemeInit("/studio", "system", true)).toEqual(["dark"]);
  });

  it("Studio 明确保存的暗色选择仍然生效", () => {
    expect(runThemeInit("/studio/settings", "dark", false)).toEqual(["dark"]);
  });
});
