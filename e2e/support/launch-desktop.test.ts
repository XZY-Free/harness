import { createRequire } from "node:module";
import { describe, expect, it } from "vitest";
import { buildDesktopLaunchArgs } from "./launch-desktop";

const require = createRequire(import.meta.url);
const { applyRealKeyringCommandLine } = require("./electron-real-keyring-loader.cjs") as {
  applyRealKeyringCommandLine: (
    commandLine: {
      removeSwitch(name: string): void;
      appendSwitch(name: string, value?: string): void;
    },
    platform: NodeJS.Platform,
  ) => void;
};

describe("buildDesktopLaunchArgs", () => {
  it("在应用路径之前 preload 真实 keyring 修正器", () => {
    const args = buildDesktopLaunchArgs("/tmp/snow-harness-e2e");

    expect(args[0]).toBe("-r");
    expect(args[1]).toMatch(/electron-real-keyring-loader\.cjs$/);
    expect(args[2]).toBe("--no-sandbox");
    expect(args[3]).toBe("--user-data-dir=/tmp/snow-harness-e2e");
    expect(args[4]).toMatch(/desktop\/package-app$/);
    expect(args).not.toContain("--password-store=gnome-libsecret");
  });
});

describe("applyRealKeyringCommandLine", () => {
  it("Linux 移除 Playwright mock/basic 并选择 gnome-libsecret", () => {
    const removed: string[] = [];
    const appended: Array<[string, string | undefined]> = [];

    applyRealKeyringCommandLine(
      {
        removeSwitch: (name) => removed.push(name),
        appendSwitch: (name, value) => appended.push([name, value]),
      },
      "linux",
    );

    expect(removed).toEqual(["use-mock-keychain", "password-store"]);
    expect(appended).toEqual([["password-store", "gnome-libsecret"]]);
  });

  it("macOS 只移除 Playwright mock/basic，保留系统 Keychain", () => {
    const removed: string[] = [];
    const appended: Array<[string, string | undefined]> = [];

    applyRealKeyringCommandLine(
      {
        removeSwitch: (name) => removed.push(name),
        appendSwitch: (name, value) => appended.push([name, value]),
      },
      "darwin",
    );

    expect(removed).toEqual(["use-mock-keychain", "password-store"]);
    expect(appended).toEqual([]);
  });
});
