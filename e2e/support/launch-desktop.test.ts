import { describe, expect, it } from "vitest";
import { buildDesktopLaunchArgs } from "./launch-desktop";

describe("buildDesktopLaunchArgs", () => {
  it("把 Chromium 安全与 keyring 开关放在应用路径之前", () => {
    const args = buildDesktopLaunchArgs("/tmp/snow-harness-e2e");

    expect(args.slice(0, 3)).toEqual([
      "--no-sandbox",
      "--password-store=gnome-libsecret",
      "--user-data-dir=/tmp/snow-harness-e2e",
    ]);
    expect(args[3]).toMatch(/desktop\/package-app$/);
  });
});
