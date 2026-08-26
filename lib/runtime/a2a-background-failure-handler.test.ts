/**
 * A2A 背景流失败 Handler 测试（06 §9/§12）。
 *
 * 幂等性：背景失败 callback 重复 → 只形成一个 lost 事实；
 * waiting_user → no-op；已终态 → no-op；Invocation 不存在 → no-op。
 */
import { db } from "@/lib/db/client";
import { resetDatabase } from "@/lib/db/test/mysql-harness";
import { threadEventTable } from "@/lib/persistence/schema/conversation";
import { invocationTable } from "@/lib/persistence/schema/executions";
import { handleA2ABackgroundFailure } from "@/lib/runtime/a2a-background-failure-handler";
import { dispatchInvocationForTurn } from "@/lib/runtime/dispatcher";
import { getInvocationById } from "@/lib/runtime/invocation-queries";
import { seedDispatchableTurn } from "@/lib/test-support/seed-dispatchable-turn";
import { eq } from "drizzle-orm";
import { beforeEach, describe, expect, it } from "vitest";

beforeEach(async () => {
  await resetDatabase(db);
});

describe("handleA2ABackgroundFailure（06 §9 幂等恢复）", () => {
  it("running Invocation 背景失败 → markInvocationLost（lost 终态 + reasonCode=failureKind）", async () => {
    const ctx = await seedDispatchableTurn();
    const dispatch = await dispatchInvocationForTurn({
      tenantId: ctx.tenantId,
      turnId: ctx.turnId,
    });
    expect(dispatch.invocation).not.toBeNull();

    await handleA2ABackgroundFailure({
      tenantId: ctx.tenantId,
      report: {
        invocationId: dispatch.invocation!.id,
        failureKind: "stream_read_failed",
        safeSummary: "socket reset by peer",
      },
    });
    const lost = await getInvocationById(ctx.tenantId, dispatch.invocation!.id);
    expect(lost?.executionState).toBe("lost");
    expect(lost?.errorCode).toBe("stream_read_failed");
  });

  it("06 §12-8：背景失败 callback 重复 → 只形成一个 lost 事实（幂等 no-op）", async () => {
    const ctx = await seedDispatchableTurn();
    const dispatch = await dispatchInvocationForTurn({
      tenantId: ctx.tenantId,
      turnId: ctx.turnId,
    });
    const invocationId = dispatch.invocation!.id;
    for (let i = 0; i < 3; i++) {
      await handleA2ABackgroundFailure({
        tenantId: ctx.tenantId,
        report: {
          invocationId,
          failureKind: "stream_eof_before_terminal",
          safeSummary: "重复回调",
        },
      });
    }
    const lost = await getInvocationById(ctx.tenantId, invocationId);
    expect(lost?.executionState).toBe("lost");
    // invocation.lost ThreadEvent 恰一条（幂等：第二次起 no-op）。
    const lostEvents = await db
      .select({ id: threadEventTable.id })
      .from(threadEventTable)
      .where(eq(threadEventTable.eventType, "invocation.lost"));
    expect(lostEvents).toHaveLength(1);
    const [row] = await db
      .select({ errorCode: invocationTable.errorCode })
      .from(invocationTable)
      .where(eq(invocationTable.id, invocationId));
    expect(row?.errorCode).toBe("stream_eof_before_terminal");
  });

  it("06 §9.3：正常 waiting_user → no-op（保持 waiting_user，等用户 Resume）", async () => {
    const ctx = await seedDispatchableTurn();
    const dispatch = await dispatchInvocationForTurn({
      tenantId: ctx.tenantId,
      turnId: ctx.turnId,
    });
    const invocationId = dispatch.invocation!.id;
    // 直接置 waiting_user（模拟 input-required 已进 ingress）。
    await db
      .update(invocationTable)
      .set({ executionState: "waiting_user" })
      .where(eq(invocationTable.id, invocationId));
    await handleA2ABackgroundFailure({
      tenantId: ctx.tenantId,
      report: { invocationId, failureKind: "stream_read_failed", safeSummary: "断流" },
    });
    const after = await getInvocationById(ctx.tenantId, invocationId);
    expect(after?.executionState).toBe("waiting_user");
  });

  it("Invocation 不存在/跨租户 → no-op（不抛错）", async () => {
    await expect(
      handleA2ABackgroundFailure({
        tenantId: "tenant-nonexistent",
        report: {
          invocationId: "inv-nonexistent",
          failureKind: "ingress_failed",
          safeSummary: "db error",
        },
      }),
    ).resolves.toBeUndefined();
  });
});
