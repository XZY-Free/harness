import { describe, expect, it } from "vitest";
import { filterEnv } from "./safe-env";

/**
 * P1(02 Runtime P1-1):env 白名单过滤测试。
 *
 * 验证:白名单前缀放行、敏感关键字黑名单剔除、未知变量 fail-closed 剔除、
 * 显式注入叠加且不被过滤。
 */

describe("filterEnv env 白名单过滤", () => {
  it("白名单基础变量放行(PATH/HOME/USER/SHELL/TERM/TMPDIR)", () => {
    const out = filterEnv({
      PATH: "/usr/bin",
      HOME: "/home/u",
      USER: "u",
      SHELL: "/bin/zsh",
      TERM: "xterm",
      TMPDIR: "/tmp",
    });
    expect(out).toEqual({
      PATH: "/usr/bin",
      HOME: "/home/u",
      USER: "u",
      SHELL: "/bin/zsh",
      TERM: "xterm",
      TMPDIR: "/tmp",
    });
  });

  it("node/npm 生态变量放行(NPM_CONFIG_*/PNPM_HOME)；NODE_OPTIONS 已剔除（代码执行风险）", () => {
    const out = filterEnv({
      NODE_OPTIONS: "--max-old-space-size=4096",
      NPM_CONFIG_REGISTRY: "https://registry.npmjs.org",
      PNPM_HOME: "/pnpm",
      YARN_CACHE_FOLDER: "/yarn",
    });
    // 审计修复：NODE_OPTIONS 不再在白名单中（--require/--inspect 可注入任意代码）
    expect(out).toMatchObject({
      NPM_CONFIG_REGISTRY: "https://registry.npmjs.org",
      PNPM_HOME: "/pnpm",
      YARN_CACHE_FOLDER: "/yarn",
    });
    expect(out).not.toHaveProperty("NODE_OPTIONS");
  });

  it("敏感关键字变量剔除(DATABASE_URL/API_KEY/SECRET/TOKEN/PASSWORD)", () => {
    const out = filterEnv({
      DATABASE_URL: "mysql://user:pass@host/db",
      LLM_API_KEY: "sk-xxx",
      JWT_SECRET: "s3cr3t",
      GITHUB_TOKEN: "ghp_xxx",
      DB_PASSWORD: "p@ss",
      AWS_ACCESS_KEY_ID: "AKIAxxx",
      PRIVATE_KEY: "-----BEGIN-----",
    });
    expect(out).toEqual({});
  });

  it("白名单前缀但含敏感关键字 → 仍剔除(双保险)", () => {
    // NPM_CONFIG_TOKEN 命中 NPM_CONFIG_ 白名单前缀,但含 TOKEN → 剔除
    const out = filterEnv({
      NPM_CONFIG_TOKEN: "should-be-stripped",
      PATH: "/usr/bin",
    });
    expect(out).toEqual({ PATH: "/usr/bin" });
    expect(out.NPM_CONFIG_TOKEN).toBeUndefined();
  });

  it("未知变量 fail-closed 剔除(不透传未知的平台变量)", () => {
    const out = filterEnv({
      RANDOM_PLATFORM_VAR: "leak",
      CUSTOM_CONFIG: "x",
      SOME_INTERNAL_ENDPOINT: "http://internal",
      PATH: "/usr/bin",
    });
    expect(out).toEqual({ PATH: "/usr/bin" });
  });

  it("显式注入(secretsCache/opts.env)叠加且不过滤", () => {
    // 调用方明确知情注入:即便是敏感名字的 secret,也本就该传给命令(如 DEPLOY_TOKEN)
    const out = filterEnv(
      { PATH: "/usr/bin" },
      { DEPLOY_KEY: "explicit-secret", CUSTOM_BUILD_VAR: "1" },
    );
    expect(out).toEqual({
      PATH: "/usr/bin",
      DEPLOY_KEY: "explicit-secret",
      CUSTOM_BUILD_VAR: "1",
    });
  });

  it("显式注入覆盖白名单同名变量(注入优先级最高)", () => {
    const out = filterEnv({ PATH: "/usr/bin" }, { PATH: "/custom/bin" });
    expect(out.PATH).toBe("/custom/bin");
  });

  it("locale/时区变量放行(LANG/LC_*/TZ)", () => {
    const out = filterEnv({
      LANG: "en_US.UTF-8",
      LC_ALL: "en_US.UTF-8",
      TZ: "Asia/Shanghai",
    });
    expect(out).toMatchObject({
      LANG: "en_US.UTF-8",
      LC_ALL: "en_US.UTF-8",
      TZ: "Asia/Shanghai",
    });
  });
});
