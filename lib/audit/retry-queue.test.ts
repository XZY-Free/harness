import { beforeEach, describe, expect, it, vi } from "vitest";

const dbMocks = vi.hoisted(() => ({
  rows: [] as Array<{ id: string; payload: string | null; toolName: string }>,
  replayedAudit: vi.fn(),
}));

vi.mock("@/lib/db/client", () => ({
  db: {
    select: () => ({
      from: () => ({
        orderBy: () => ({ limit: async () => dbMocks.rows }),
      }),
    }),
    delete: () => ({ where: async () => undefined }),
    update: () => ({ set: () => ({ where: async () => undefined }) }),
    transaction: async (cb: (tx: unknown) => Promise<unknown>) => {
      // 事务内 FOR UPDATE select 复用 rows(模拟锁定到行);delete 同事务。
      const tx = {
        select: () => ({
          from: () => ({
            where: () => ({ for: () => ({ limit: async () => dbMocks.rows }) }),
          }),
        }),
        delete: () => ({ where: async () => undefined }),
      };
      return cb(tx);
    },
  },
}));

vi.mock("@/lib/studio/admin-audit", () => ({
  recordAdminAudit: dbMocks.replayedAudit,
}));

vi.mock("@/lib/logger", () => ({ logger: { warn: vi.fn(), error: vi.fn(), info: vi.fn() } }));

import { replayAuditFailures } from "./retry-queue";

describe("replayAuditFailures (P1-11)", () => {
  beforeEach(() => {
    dbMocks.rows = [];
    dbMocks.replayedAudit.mockReset();
  });

  it("重放成功 → 调 recordAdminAudit + 删除行", async () => {
    dbMocks.rows = [
      {
        id: "r1",
        toolName: "runCommand",
        payload: JSON.stringify({
          auditInput: {
            actorUserId: "u1",
            action: "tool.high_risk.executed",
            targetType: "tool_run",
            targetId: "tr1",
            outcome: "succeeded",
            metadata: {},
          },
        }),
      },
    ];
    dbMocks.replayedAudit.mockResolvedValue(undefined);
    const n = await replayAuditFailures();
    expect(n).toBe(1);
    expect(dbMocks.replayedAudit).toHaveBeenCalledOnce();
  });

  it("重放仍失败 → 保留行,不计数", async () => {
    dbMocks.rows = [
      {
        id: "r2",
        toolName: "runCommand",
        payload: JSON.stringify({ auditInput: { actorUserId: "u1" } }),
      },
    ];
    dbMocks.replayedAudit.mockRejectedValue(new Error("db still down"));
    const n = await replayAuditFailures();
    expect(n).toBe(0);
  });

  it("无 auditInput 的旧格式行 → 删除,不重放", async () => {
    dbMocks.rows = [{ id: "r3", toolName: "runCommand", payload: JSON.stringify({ foo: "bar" }) }];
    const n = await replayAuditFailures();
    expect(n).toBe(0);
    expect(dbMocks.replayedAudit).not.toHaveBeenCalled();
  });

  it("空队列 → 0", async () => {
    const n = await replayAuditFailures();
    expect(n).toBe(0);
  });
});
