import { PatchParseError, applyPatch, parsePatch, validatePatchPath } from "@/lib/ai/patch/apply";
import { describe, expect, it } from "vitest";

/**
 * V3.1 Stage D：patch 解析-校验-应用纯函数测试。
 */

describe("parsePatch", () => {
  it("解析单文件单 hunk", () => {
    const patch = `--- a/src/a.ts
+++ b/src/a.ts
@@ -1,3 +1,3 @@
 line1
-old line
+new line
 line3
`;
    const parsed = parsePatch(patch);
    expect(parsed.hunks).toHaveLength(1);
    expect(parsed.hunks[0]?.path).toBe("src/a.ts");
    expect(parsed.hunks[0]?.search).toEqual(["line1", "old line", "line3"]);
    expect(parsed.hunks[0]?.replace).toEqual(["line1", "new line", "line3"]);
  });

  it("解析多文件多 hunk", () => {
    const patch = `--- a/a.txt
+++ b/a.txt
@@ -1,2 +1,2 @@
 x
-y
+z
--- a/b.txt
+++ b/b.txt
@@ -1,1 +1,1 @@
-p
+q
`;
    const parsed = parsePatch(patch);
    expect(parsed.hunks.map((h) => h.path)).toEqual(["a.txt", "b.txt"]);
  });

  it("无 hunk → 抛错", () => {
    expect(() => parsePatch("nothing here")).toThrow(PatchParseError);
  });

  it("/dev/null → 抛错（V3.1 不支持新建/删除 via patch）", () => {
    const patch = `--- /dev/null
+++ b/new.txt
@@ -0,0 +1,1 @@
+hello
`;
    expect(() => parsePatch(patch)).toThrow(PatchParseError);
  });
});

describe("validatePatchPath", () => {
  it("正常相对路径 → null", () => {
    expect(validatePatchPath("src/a.ts")).toBeNull();
    expect(validatePatchPath("a/b/c.js")).toBeNull();
  });
  it("绝对路径 → 拒绝", () => {
    expect(validatePatchPath("/etc/passwd")).toMatch(/绝对路径/);
  });
  it(".. 越界 → 拒绝", () => {
    expect(validatePatchPath("../secret")).toMatch(/越界/);
    expect(validatePatchPath("a/../../b")).toMatch(/越界/);
  });
});

describe("applyPatch 应用", () => {
  it("单 hunk 精确替换", () => {
    const patch = `--- a/a.ts
+++ b/a.ts
@@ -1,3 +1,3 @@
 line1
-old
+new
 line3
`;
    const files = { "a.ts": "line1\nold\nline3\n" };
    const res = applyPatch(patch, files);
    expect(res.errors).toEqual([]);
    expect(res.results).toHaveLength(1);
    expect(res.results[0]?.after).toBe("line1\nnew\nline3\n");
    expect(res.results[0]?.changed).toBe(true);
  });

  it("context 不匹配 → 拒绝，未应用", () => {
    const patch = `--- a/a.ts
+++ b/a.ts
@@ -1,3 +1,3 @@
 line1
-WRONG
+new
 line3
`;
    const files = { "a.ts": "line1\nold\nline3\n" };
    const res = applyPatch(patch, files);
    expect(res.errors).toHaveLength(1);
    expect(res.errors[0]?.error).toMatch(/context 不匹配/);
    expect(res.results).toEqual([]);
  });

  it("search 块非唯一 → 拒绝", () => {
    const patch = `--- a/a.ts
+++ b/a.ts
@@ -1,2 +1,2 @@
 dup
-old
+new
`;
    const files = { "a.ts": "dup\nold\ndup\nold\n" };
    const res = applyPatch(patch, files);
    // "dup\nold" 在文件中出现 2 次 → 非唯一
    expect(res.errors[0]?.error).toMatch(/非唯一/);
  });

  it("路径越界 → 拒绝", () => {
    const patch = `--- a/../evil
+++ b/../evil
@@ -1,1 +1,1 @@
-x
+y
`;
    const files = { "../evil": "x\n" };
    const res = applyPatch(patch, files);
    expect(res.errors[0]?.error).toMatch(/越界/);
  });

  it("文件不存在 → 错误", () => {
    const patch = `--- a/missing.ts
+++ b/missing.ts
@@ -1,1 +1,1 @@
-x
+y
`;
    const res = applyPatch(patch, {});
    expect(res.errors[0]?.error).toMatch(/文件不存在/);
  });

  it("多 hunk 同文件顺序应用", () => {
    const patch = `--- a/a.ts
+++ b/a.ts
@@ -1,1 +1,1 @@
-one
+1
@@ -3,1 +3,1 @@
-two
+2
`;
    const files = { "a.ts": "one\nx\ntwo\n" };
    const res = applyPatch(patch, files);
    expect(res.errors).toEqual([]);
    expect(res.results.at(-1)?.after).toBe("1\nx\n2\n");
  });

  it("纯新增 hunk（无 context/removed）→ 拒绝", () => {
    const patch = `--- a/a.ts
+++ b/a.ts
@@ -1,0 +1,1 @@
+inserted
`;
    const files = { "a.ts": "x\n" };
    const res = applyPatch(patch, files);
    expect(res.errors[0]?.error).toMatch(/纯新增 hunk 需 context/);
  });
});
