import { describe, expect, it } from "vitest";
import { parseContextCommands } from "./user-commands";

/**
 * S1 修复（03-P1-6）：/clear + @file 命令解析测试。
 */

describe("parseContextCommands", () => {
  it("/clear 开头 → clear=true，移除命令标记", () => {
    const r = parseContextCommands("/clear\n重新开始做登录页");
    expect(r.clear).toBe(true);
    expect(r.cleanedText).toBe("重新开始做登录页");
    expect(r.fileRefs).toEqual([]);
  });

  it("/clear 后跟换行 + 新指令 → 识别 clear，保留新指令", () => {
    const r = parseContextCommands("/clear\n做登录页");
    expect(r.clear).toBe(true);
    expect(r.cleanedText).toBe("做登录页");
  });

  it("/clear 同行后跟正文 → 识别 clear，保留正文（去掉 /clear token）", () => {
    const r = parseContextCommands("/clear 做登录页");
    expect(r.clear).toBe(true);
    expect(r.cleanedText).toBe("做登录页");
  });

  it("正文里的 /clear（非开头）→ 不识别为命令", () => {
    const r = parseContextCommands("帮我做 /clear 按钮");
    expect(r.clear).toBe(false);
  });

  it("@file 引用 → 提取路径 + 从正文移除", () => {
    const r = parseContextCommands("参考 @file src/main.ts 改一下");
    expect(r.fileRefs).toEqual(["src/main.ts"]);
    expect(r.cleanedText).toBe("参考 改一下");
  });

  it("@file 引号包裹含空格路径", () => {
    const r = parseContextCommands('看下 @file "src/my file.ts"');
    expect(r.fileRefs).toEqual(["src/my file.ts"]);
  });

  it("多个 @file 去重保序", () => {
    const r = parseContextCommands("@file a.ts @file b.ts @file a.ts");
    expect(r.fileRefs).toEqual(["a.ts", "b.ts"]);
  });

  it("/clear + @file 组合", () => {
    const r = parseContextCommands("/clear\n基于 @file config.ts 重做");
    expect(r.clear).toBe(true);
    expect(r.fileRefs).toEqual(["config.ts"]);
    expect(r.cleanedText).toBe("基于 重做");
  });

  it("无命令 → 原样（清理空白）", () => {
    const r = parseContextCommands("做一个待办清单");
    expect(r.clear).toBe(false);
    expect(r.fileRefs).toEqual([]);
    expect(r.cleanedText).toBe("做一个待办清单");
  });
});
