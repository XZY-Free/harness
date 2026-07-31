import { describe, expect, it } from "vitest";
import { runWhitelistedScript } from "./scripts";

/**
 * S1（10-P2-6）：custom-tools 脚本白名单测试。
 * 验证：白名单脚本执行 + 非白名单拒绝（命门 #2，绝不执行用户任意代码）。
 */

describe("custom-tools 脚本白名单（10-P2-6）", () => {
  it("白名单 echo → 执行回显", async () => {
    const r = await runWhitelistedScript("echo", { msg: "hello" });
    expect(r.ok).toBe(true);
    if (r.ok) expect(r.content).toEqual({ msg: "hello" });
  });

  it("白名单 noop → 返回 null content", async () => {
    const r = await runWhitelistedScript("noop", {});
    expect(r.ok).toBe(true);
  });

  it("非白名单 scriptId → 拒绝（命门 #2）", async () => {
    const r = await runWhitelistedScript("rm-rf-slash", {});
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.error).toContain("不在白名单");
  });

  it("eval → 拒绝（不在白名单）", async () => {
    const r = await runWhitelistedScript("eval", { code: "process.exit(1)" });
    expect(r.ok).toBe(false);
  });

  it("空 scriptId → 拒绝", async () => {
    const r = await runWhitelistedScript("", {});
    expect(r.ok).toBe(false);
  });
});
