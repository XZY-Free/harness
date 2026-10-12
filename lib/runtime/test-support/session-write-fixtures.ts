/**
 * Session 写入的测试夹具入口（R02 §8）。
 *
 * 生产侧 Session 写入必须是「调用方事务 + 行锁 + 版本 CAS」的仓储方法；
 * 夹具不应各自复制事务样板，也不应绕过仓储。这里只做「开事务 → 调用生产仓储方法」，
 * 并把行版本显式传给 CAS，不引入任何测试专用写路径。
 */
import { db } from "@/lib/db/client";
import {
  assertExecutionSourceSnapshot,
  executionSourceDigest,
} from "@/lib/executions/domain/preparation-source";
import { lockInvocationRootIfExists } from "@/lib/executions/persistence/execution-ownership-store";
import {
  executionOwnershipTable,
  invocationAttemptTable,
} from "@/lib/persistence/schema/executions";
import type {
  RuntimeSessionBinding,
  RuntimeSessionIntentType,
} from "@/lib/persistence/schema/executions";
import {
  type CreateRuntimeSessionBindingInput,
  type RuntimeSessionDispatchPatch,
  createRuntimeSessionBindingInTransaction,
  lockRuntimeSessionBindingInTransaction,
  updateRuntimeSessionDispatchInTransaction,
} from "@/lib/runtime/persistence/runtime-session-store";
import { protocolDigest } from "@/lib/runtime/runtime-protocol";
import { ensureTestRuntimeRevision } from "@/lib/runtime/test-support/seed-test-runtime-revision";
import { and, eq } from "drizzle-orm";

type CreateRuntimeSessionBindingFixtureInput = Omit<
  CreateRuntimeSessionBindingInput,
  "preparationClaim"
> & {
  sourceOperationKey?: string;
  sourceRequestDigest?: string;
};

export async function createRuntimeSessionBindingForTest(
  input: CreateRuntimeSessionBindingFixtureInput,
): Promise<RuntimeSessionBinding> {
  await ensureTestRuntimeRevision(input.tenantId, input.runtimeRevisionId);
  return db.transaction(async (tx) => {
    if (!(await lockInvocationRootIfExists(tx, input.tenantId, input.invocationId))) {
      throw new Error("测试 Session 的 Invocation 不存在");
    }
    const [attempt] = await tx
      .select()
      .from(invocationAttemptTable)
      .where(
        and(
          eq(invocationAttemptTable.tenantId, input.tenantId),
          eq(invocationAttemptTable.id, input.attemptId),
          eq(invocationAttemptTable.invocationId, input.invocationId),
        ),
      )
      .for("update")
      .limit(1);
    if (
      !attempt ||
      !attempt.preparationClaimId ||
      !attempt.preparationIntentKey ||
      !attempt.preparationRequestDigest ||
      !attempt.preparationSourceJson
    ) {
      throw new Error("测试 Session 缺少合法准备领取");
    }
    const source = assertExecutionSourceSnapshot(attempt.preparationSourceJson);
    if (executionSourceDigest(source) !== attempt.preparationRequestDigest) {
      throw new Error("测试 Session 的准备来源损坏");
    }
    const [ownership] = await tx
      .select({ id: executionOwnershipTable.id })
      .from(executionOwnershipTable)
      .where(
        and(
          eq(executionOwnershipTable.tenantId, input.tenantId),
          eq(executionOwnershipTable.id, input.ownershipId),
          eq(executionOwnershipTable.attemptId, input.attemptId),
        ),
      )
      .for("update")
      .limit(1);
    if (!ownership) throw new Error("测试 Session 的 Ownership 不存在");
    const {
      sourceOperationKey: _sourceKey,
      sourceRequestDigest: _sourceDigest,
      ...sessionInput
    } = input;
    return createRuntimeSessionBindingInTransaction(tx, {
      ...sessionInput,
      preparationClaim: {
        tenantId: input.tenantId,
        invocationId: input.invocationId,
        attemptId: input.attemptId,
        intentKey: attempt.preparationIntentKey,
        requestDigest: attempt.preparationRequestDigest,
        claimId: attempt.preparationClaimId,
        source,
      },
    });
  });
}

/**
 * A05 夹具：由**稳定事实**派生来源意图对。
 *
 * 夹具必须与生产同构，所以这里不许用时间/随机数，也不许用任意字符串冒充摘要：
 * `sourceRequestDigest` 的列宽是 `ascii(71)`（`sha256:<64hex>` 恰好占满），
 * 拿"看着像摘要"的短串充数会绕过真实列宽约束，让一次真实的 `ER_DATA_TOO_LONG`
 * 推迟到生产才暴露。
 */
export function sourceIntentForFixture(input: {
  tenantId: string;
  invocationId: string;
  attemptId: string;
  intentType: RuntimeSessionIntentType;
}): { sourceOperationKey: string; sourceRequestDigest: string } {
  return {
    sourceOperationKey: `invocation:${input.invocationId}`,
    sourceRequestDigest: protocolDigest({
      scope: "fixture-source-intent",
      tenantId: input.tenantId,
      invocationId: input.invocationId,
      attemptId: input.attemptId,
      intentType: input.intentType,
    }),
  };
}

/** 与生产同名写入等价：锁 Session 行 → 用当前行版本 CAS → 走单向转换表。 */
export async function applyRuntimeSessionDispatchForTest(
  tenantId: string,
  sessionBindingId: string,
  patch: RuntimeSessionDispatchPatch,
): Promise<RuntimeSessionBinding> {
  return db.transaction(async (tx) => {
    const current = await lockRuntimeSessionBindingInTransaction(tx, tenantId, sessionBindingId);
    return updateRuntimeSessionDispatchInTransaction(tx, {
      tenantId,
      id: sessionBindingId,
      expectedVersionNo: current.versionNo,
      patch,
    });
  });
}
