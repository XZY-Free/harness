import { beforeEach, describe, expect, it, vi } from "vitest";

/**
 * Phase 4-4 切片 C Stage B：审计脱敏与摘要单测。
 *
 * 断言：
 * - secret-like key（含 secret/token/password/apiKey/content/commandOutput，大小写不敏感）被剔除。
 * - 长 string 截断到 256。
 * - 文件操作只记 path + bytes，content 被剔除。
 * - 嵌套对象深度限制到 2，超深折叠。
 * - metadata 仍可 JSON 序列化。
 * - recordAdminAudit 解析 actor 租户，脱敏后追加 AuditEvent。
 */

const auditQueries = vi.hoisted(() => ({ appendAuditEvent: vi.fn() }));
const dbMocks = vi.hoisted(() => {
  const limit = vi.fn().mockResolvedValue([{ tenantId: "t1" }]);
  const where = vi.fn(() => ({ limit }));
  const from = vi.fn(() => ({ where }));
  const select = vi.fn(() => ({ from }));
  return { db: { select }, select, from, where, limit };
});
vi.mock("@/lib/db/client", () => ({ db: dbMocks.db }));
vi.mock("@/lib/identity/audit-queries", () => ({
  appendAuditEvent: auditQueries.appendAuditEvent,
  listAuditEvents: vi.fn(),
}));

import {
  recordAdminAudit,
  sanitizeAuditMetadata,
  summarizeRoleChange,
} from "@/lib/studio/admin-audit";

beforeEach(() => {
  vi.clearAllMocks();
  dbMocks.limit.mockResolvedValue([{ tenantId: "t1" }]);
  auditQueries.appendAuditEvent.mockResolvedValue({ id: "audit-1" });
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

describe("summarizeRoleChange (切片 C)", () => {
  it("返回 before/after roleIds，不含其他敏感字段", () => {
    const summary = summarizeRoleChange(["r-member"], ["r-admin"]);
    expect(summary).toEqual({ roleIdsBefore: ["r-member"], roleIdsAfter: ["r-admin"] });
  });
});

describe("recordAdminAudit (切片 C)", () => {
  it("解析 actor 租户，脱敏 metadata 后追加 AuditEvent", async () => {
    await recordAdminAudit({
      actorUserId: "u1",
      action: "policies.updated",
      targetType: "policy",
      targetId: "policy",
      outcome: "succeeded",
      metadata: { keys: ["a"], changedKeys: ["a"], apiKey: "sk-leak", content: "secret-content" },
    });
    expect(auditQueries.appendAuditEvent).toHaveBeenCalledTimes(1);
    const passed = auditQueries.appendAuditEvent.mock.calls[0]?.[0] as Record<string, unknown>;
    expect(passed).toMatchObject({
      tenantId: "t1",
      actorType: "user",
      actorId: "u1",
      actionType: "policies.updated",
      targetType: "policy",
      targetId: "policy",
      outcome: "succeeded",
      metadataRedacted: { keys: ["a"], changedKeys: ["a"] },
    });
    expect(JSON.stringify(passed.metadataRedacted)).not.toContain("sk-leak");
  });

  it("actor 不存在时明确失败，不写审计", async () => {
    dbMocks.limit.mockResolvedValueOnce([]);
    await expect(
      recordAdminAudit({
        actorUserId: "missing",
        action: "policies.updated",
        targetType: "policy",
        targetId: "policy",
        outcome: "failed",
        metadata: {},
      }),
    ).rejects.toThrow("审计 actor 不存在");
    expect(auditQueries.appendAuditEvent).not.toHaveBeenCalled();
  });
});
