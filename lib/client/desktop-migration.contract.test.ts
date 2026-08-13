import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

const retiredName = `v${11}`;

describe("desktop formal thread client contract", () => {
  it("uses permanent page file names", () => {
    expect(existsSync(join(process.cwd(), "components/thread/thread-page.tsx"))).toBe(true);
    expect(existsSync(join(process.cwd(), "components/thread/new-thread-page.tsx"))).toBe(true);
    expect(existsSync(join(process.cwd(), `components/thread/${retiredName}-thread-page.tsx`))).toBe(
      false,
    );
    expect(
      existsSync(join(process.cwd(), `components/thread/${retiredName}-new-thread-page.tsx`)),
    ).toBe(false);
  });

  it("exports permanent Thread hook symbols", () => {
    const thread = readFileSync(join(process.cwd(), "components/hooks/use-thread.ts"), "utf8");
    const detail = readFileSync(
      join(process.cwd(), "components/hooks/use-thread-detail.ts"),
      "utf8",
    );
    const settings = readFileSync(
      join(process.cwd(), "components/hooks/use-thread-settings.ts"),
      "utf8",
    );
    expect(thread).toContain("export function useThread(");
    expect(thread).toContain("export interface UseThreadResult");
    expect(detail).toContain("export function useThreadDetail(");
    expect(settings).toContain("export function useThreadSettings(");
    expect(`${thread}\n${detail}\n${settings}`).not.toMatch(
      new RegExp(`use${retiredName.toUpperCase()}|Use${retiredName.toUpperCase()}`),
    );
  });

  it("uses shared client contracts and one sidebar implementation", () => {
    const renderer = readFileSync(
      join(process.cwd(), "desktop/renderer/src/desktop-renderer-app.tsx"),
      "utf8",
    );
    expect(renderer).not.toMatch(/interface Desktop(Thread|Agent|Shell)/);
    expect(renderer).toContain("@/lib/client/types");
    expect(renderer).toContain("@/components/thread/sidebar/desktop-sidebar");
    expect(existsSync(join(process.cwd(), "components/desktop/sidebar/desktop-sidebar.tsx"))).toBe(
      false,
    );
  });
});
