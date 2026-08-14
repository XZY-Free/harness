import { readFileSync } from "node:fs";
import { join } from "node:path";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it, vi } from "vitest";

vi.mock("next/script", () => ({
  default: ({
    strategy: _strategy,
    ...props
  }: React.ComponentPropsWithoutRef<"script"> & { strategy?: string }) => <script {...props} />,
}));

import RootLayout from "./layout";

function extractThemeInitScript(): string {
  const markup = renderToStaticMarkup(
    <RootLayout>
      <div>content</div>
    </RootLayout>,
  );
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
      },
    },
  };

  new Function("localStorage", "window", "document", script)(localStorage, window, document);
  return added;
}

describe("themeInitScript", () => {
  it("员工 Web 与 Desktop 没有保存主题时都默认使用浅色", () => {
    expect(runThemeInit("/desktop/chat/thread-1", null, true)).toEqual(["light"]);
    expect(runThemeInit("/chat/new", null, true)).toEqual(["light"]);
  });

  it("Studio 保存的暗色选择不污染员工 Web 与 Desktop", () => {
    expect(runThemeInit("/desktop/chat/thread-1", "dark", false)).toEqual(["light"]);
    expect(runThemeInit("/chat/new", "dark", false)).toEqual(["light"]);
  });

  it("Studio 没有保存主题时继续跟随系统主题", () => {
    expect(runThemeInit("/studio", null, true)).toEqual(["dark"]);
  });
});
