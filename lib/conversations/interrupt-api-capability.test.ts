/**
 * Interrupt API 前置门禁测试（05 §7）。
 *
 * cancel=false：不创建 command、不写 interrupt_requested、不调用 Gateway，
 * 返回稳定 UNSUPPORTED_CAPABILITY（409）；Base Harness（cancel=true）不回归。
 */
import { POST as interruptPOST } from "@/app/api/v1/turns/[turn_id]/interrupt/route";
import { db } from "@/lib/db/client";
import { buildApiRequest } from "@/lib/db/test/api-fixtures";
import { resetDatabase } from "@/lib/db/test/mysql-harness";
import { invocationCommandTable } from "@/lib/persistence/schema/conversation";
import { runtimeRevisionTable } from "@/lib/persistence/schema/runtimes";
import { dispatchInvocationForTurn } from "@/lib/runtime/dispatcher";
import { seedDispatchableTurn } from "@/lib/test-support/seed-dispatchable-turn";
import { eq } from "drizzle-orm";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

const ORIGINAL_AUTH_MODE = process.env.SNOW_AUTH_MODE;

beforeEach(async () => {
  process.env.SNOW_AUTH_MODE = "dev";
  await resetDatabase(db);
});

afterEach(() => {
  process.env.SNOW_AUTH_MODE = ORIGINAL_AUTH_MODE;
});

/** 中文注释：把 RuntimeRevision 能力改为三态投影（cancel not_applicable → base cancel=false）。 */
async function revokeRuntimeCancel(runtimeRevisionId: string): Promise<void> {
  await db
    .update(runtimeRevisionTable)
    .set({
      runtimeCapabilitiesJson: {
        declared: {},
        measured: {
          features: {
            streaming_transport: "pass",
            incremental_content: "not_applicable",
            input_required: "pass",
            resume: "pass",
            cancel: "not_applicable",
            durable_task_recovery: "not_measured",
          },
        },
        effective: {},
      },
    })
    .where(eq(runtimeRevisionTable.id, runtimeRevisionId));
}

describe("POST /api/v1/turns/{turn_id}/interrupt — capability 前置门禁（05 §7）", () => {
  it("Base Harness（measured cancel 可用）→ 门禁放行（Hosted 现有语义不回归）", async () => {
    const ctx = await seedDispatchableTurn();
    const dispatch = await dispatchInvocationForTurn({
      tenantId: ctx.tenantId,
      turnId: ctx.turnId,
    });
    expect(dispatch.invocation).not.toBeNull();

    const response = await interruptPOST(
      buildApiRequest({
        audience: "employee",
        method: "POST",
        path: `/turns/${ctx.turnId}/interrupt`,
        idempotencyKey: "caps-gate-pass-1",
        body: { reason_code: "user_cancel" },
      }),
      { params: Promise.resolve({ turn_id: ctx.turnId }) },
    );
    expect(response.status).toBe(202);
  });

  it("effective cancel=false → 409 UNSUPPORTED_CAPABILITY，无 command 入队", async () => {
    const ctx = await seedDispatchableTurn();
    const dispatch = await dispatchInvocationForTurn({
      tenantId: ctx.tenantId,
      turnId: ctx.turnId,
    });
    expect(dispatch.invocation).not.toBeNull();
    await revokeRuntimeCancel(ctx.runtimeRevision.id);

    const response = await interruptPOST(
      buildApiRequest({
        audience: "employee",
        method: "POST",
        path: `/turns/${ctx.turnId}/interrupt`,
        idempotencyKey: "caps-gate-deny-1",
        body: { reason_code: "user_cancel" },
      }),
      { params: Promise.resolve({ turn_id: ctx.turnId }) },
    );
    expect(response.status).toBe(409);
    const body = (await response.json()) as { error: { code: string } };
    expect(body.error.code).toBe("UNSUPPORTED_CAPABILITY");
    // 不创建 interrupt command（DB 无 interrupt 命令行）。
    const commands = await db.select().from(invocationCommandTable);
    expect(commands.filter((c) => c.commandType === "interrupt")).toHaveLength(0);
  });
});
