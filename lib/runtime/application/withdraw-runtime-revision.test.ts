import { describe, expect, it, vi } from "vitest";
import { createWithdrawRuntimeRevision } from "./withdraw-runtime-revision";

describe("withdraw runtime revision", () => {
  it("追加 Withdrawal 并原子切换 Runtime 当前 Revision", async () => {
    const session = {
      findRevision: vi.fn(async () => ({
        id: "revision-2",
        runtimeId: "runtime-1",
        revisionNo: 2,
        revisionState: "published",
      })),
      findRuntime: vi.fn(async () => ({ id: "runtime-1", versionNo: 4 })),
      findPublication: vi.fn(async () => ({ id: "publication-2" })),
      findLatestPublishedRevisionId: vi.fn(async () => "revision-1"),
      appendWithdrawal: vi.fn(async () => undefined),
      markRevisionWithdrawn: vi.fn(async () => true),
      setRuntimeCurrentRevision: vi.fn(async () => true),
      appendAudit: vi.fn(async () => undefined),
      appendOutbox: vi.fn(async () => undefined),
      completeIdempotency: vi.fn(async () => true),
    };
    const withdraw = createWithdrawRuntimeRevision({
      store: { transaction: async (operation) => operation(session) },
      now: () => new Date("2026-08-11T00:00:00.000Z"),
      newId: (() => {
        const ids = ["withdrawal-1", "audit-1", "outbox-1"];
        return () => ids.shift() ?? "unexpected";
      })(),
    });

    await expect(
      withdraw({
        tenantId: "tenant-1",
        revisionId: "revision-2",
        runtimeExpectedVersionNo: 4,
        actor: { tenantId: "tenant-1", actorType: "user", actorId: "user-1" },
        reasonCode: "security_response",
        reason: "发现风险",
        requestId: "request-1",
      }),
    ).resolves.toMatchObject({
      withdrawalRecordId: "withdrawal-1",
      currentRevisionId: "revision-1",
    });
    expect(session.appendWithdrawal).toHaveBeenCalledWith(
      expect.objectContaining({ publicationRecordId: "publication-2", revisionId: "revision-2" }),
    );
  });
});
