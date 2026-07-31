import { beforeEach, describe, expect, it, vi } from "vitest";

/**
 * Phase 4-4 切片 C Stage B：审计脱敏与摘要单测。
 *
 * 断言：
 * - secret-like key（含 secret/token/password/apiKey/content/commandOutput，大小写不敏感）被剔除。
 * - 长 string 截断到 256。
 * - 文件操作只记 path + bytes，content 被剔除。
 * - policy 摘要只报 key 名（keys / changedKeys），不含命令全文。
 * - 嵌套对象深度限制到 2，超深折叠。
 * - metadata 仍可 JSON 序列化。
 * - recordAdminAudit 脱敏后转发给 appendAdminAuditLog。
 */

const queries = vi.hoisted(() => ({ appendAdminAuditLog: vi.fn() }));
vi.mock("@/lib/db/queries", () => ({ appendAdminAuditLog: queries.appendAdminAuditLog }));

import {
  type AppendAdminAuditLogInput,
  recordAdminAudit,
  sanitizeAuditMetadata,
  summarizePolicyChange,
  summarizeRoleChange,
} from "@/lib/studio/admin-audit";

beforeEach(() => {
  vi.clearAllMocks();
  queries.appendAdminAuditLog.mockImplementation(async (input: AppendAdminAuditLogInput) => ({
    id: "audit-1",
    createdAt: new Date(),
    ...input,
  }));
});

describe("sanitizeAuditMetadata (切片 C)", () => {
  it("剔除 secret-like key（大小写不敏感）", () => {
    const out = sanitizeAuditMetadata({
      apiKey: "sk-x",
      ApiKey: "sk-y",
      token: "t",
      Password: "p",
      mySecret: "s",
      content: "c",
      commandOutput: "o",
      refreshToken: "r",
      safeKey: "keep",
    });
    expect(out).toEqual({ safeKey: "keep" });
  });

  it("长 string 截断到 256 + 省略号", () => {
    const long = "a".repeat(300);
    const out = sanitizeAuditMetadata({ path: "src/app.js", note: long }) as {
      note: string;
      path: string;
    };
    expect(out.path).toBe("src/app.js");
    expect(out.note.length).toBeLessThanOrEqual(257);
    expect(out.note.startsWith("a".repeat(256))).toBe(true);
  });

  it("文件操作只记 path + bytes，content 被剔除", () => {
    const out = sanitizeAuditMetadata({
      path: "src/app.js",
      content: "console.log(1)",
      bytes: 1234,
    });
    expect(out).toEqual({ path: "src/app.js", bytes: 1234 });
    expect("content" in out).toBe(false);
  });

  it("数组截断到 50 项", () => {
    const arr = Array.from({ length: 80 }, (_, i) => i);
    const out = sanitizeAuditMetadata({ roleIdsAfter: arr }) as { roleIdsAfter: number[] };
    expect(out.roleIdsAfter).toHaveLength(50);
    expect(out.roleIdsAfter[0]).toBe(0);
  });

  it("嵌套对象最大深度 2，超深折叠", () => {
    const out = sanitizeAuditMetadata({
      level1: {
        level2: {
          level3: { deep: "dropped" },
          keep: "ok",
        },
      },
    }) as { level1: { level2: Record<string, unknown> } };
    expect(out.level1.level2.keep).toBe("ok");
    // level3 是第 3 层对象 → 折叠为占位
    expect(typeof out.level1.level2.level3).toBe("string");
  });

  it("结果可 JSON 序列化（无循环、无函数）", () => {
    const out = sanitizeAuditMetadata({
      a: 1,
      b: { c: [1, 2, { d: "x" }], e: "y" },
      fn: () => 0,
    });
    expect(() => JSON.stringify(out)).not.toThrow();
    const parsed = JSON.parse(JSON.stringify(out));
    expect(parsed.a).toBe(1);
    expect(parsed.fn).toBeUndefined();
  });
});

describe("summarizePolicyChange (切片 C)", () => {
  it("只报 key 名，changedKeys 为值变化的 key", () => {
    const before = [
      { key: "protectedPaths", value: ["^\\.git"] },
      { key: "commandDenyList", value: ["rm -rf"] },
      { key: "formatOnWrite", value: { enabled: true, command: "prettier --write" } },
    ];
    const after = [
      { key: "protectedPaths", value: ["^\\.git"] },
      { key: "commandDenyList", value: ["rm -rf", "sudo"] },
      { key: "formatOnWrite", value: { enabled: true, command: "prettier --write" } },
    ];
    const summary = summarizePolicyChange(before, after);
    expect(summary.keys).toEqual(["protectedPaths", "commandDenyList", "formatOnWrite"]);
    expect(summary.changedKeys).toEqual(["commandDenyList"]);
  });

  it("新增 key 计入 changedKeys", () => {
    const before = [{ key: "protectedPaths", value: ["^\\.git"] }];
    const after = [
      { key: "protectedPaths", value: ["^\\.git"] },
      { key: "formatOnWrite", value: { enabled: true } },
    ];
    const summary = summarizePolicyChange(before, after);
    expect(summary.changedKeys).toEqual(["formatOnWrite"]);
  });

  it("不包含命令全文 / value 明文", () => {
    const before = [{ key: "formatOnWrite", value: { command: "old" } }];
    const after = [{ key: "formatOnWrite", value: { command: "prettier --write --cache" } }];
    const summary = summarizePolicyChange(before, after);
    expect(JSON.stringify(summary)).not.toContain("prettier");
    expect(JSON.stringify(summary)).not.toContain("old");
  });
});

describe("summarizeRoleChange (切片 C)", () => {
  it("返回 before/after roleIds，不含其他敏感字段", () => {
    const summary = summarizeRoleChange(["r-member"], ["r-admin"]);
    expect(summary).toEqual({ roleIdsBefore: ["r-member"], roleIdsAfter: ["r-admin"] });
  });
});

describe("recordAdminAudit (切片 C)", () => {
  it("脱敏 metadata 后转发给 appendAdminAuditLog", async () => {
    await recordAdminAudit({
      actorUserId: "u1",
      action: "policies.updated",
      targetType: "policy",
      targetId: "policy",
      outcome: "succeeded",
      metadata: { keys: ["a"], changedKeys: ["a"], apiKey: "sk-leak", content: "secret-content" },
    });
    expect(queries.appendAdminAuditLog).toHaveBeenCalledTimes(1);
    const passed = queries.appendAdminAuditLog.mock.calls[0]?.[0] as AppendAdminAuditLogInput;
    expect(passed.metadata).toEqual({ keys: ["a"], changedKeys: ["a"] });
    expect(JSON.stringify(passed.metadata)).not.toContain("sk-leak");
  });
});
