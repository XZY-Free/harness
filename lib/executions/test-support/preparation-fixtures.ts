import { randomUUID } from "node:crypto";
import { db } from "@/lib/db/client";
import {
  type ExecutionSourceSnapshot,
  assertExecutionSourceSnapshot,
  executionSourceDigest,
} from "@/lib/executions/domain/preparation-source";
import {
  type AttemptTx,
  claimAttemptPreparationInTransaction,
  markAttemptPreparedInTransaction,
} from "@/lib/executions/persistence/attempt-store";
import { lockInvocationRootIfExists } from "@/lib/executions/persistence/execution-ownership-store";
import {
  executionBindingTable,
  invocationAttemptTable,
  invocationTable,
} from "@/lib/persistence/schema/executions";
import { eq } from "drizzle-orm";

/**
 * 仅供测试建初始合法 Prepared 事实。它仍经过真实 I → A 领取和生产提交守卫，
 * 不在生产函数中增加 NODE_ENV 或空 claim 旁路。
 */
export async function markAttemptPreparedForTestInTransaction(
  tx: AttemptTx,
  input: { attemptId: string; evidence: unknown; digest: string; now?: Date },
) {
  const [locator] = await tx
    .select({
      tenantId: invocationAttemptTable.tenantId,
      invocationId: invocationAttemptTable.invocationId,
    })
    .from(invocationAttemptTable)
    .where(eq(invocationAttemptTable.id, input.attemptId))
    .limit(1);
  if (!locator) throw new Error(`测试 Attempt 不存在（id=${input.attemptId}）`);
  if (!(await lockInvocationRootIfExists(tx, locator.tenantId, locator.invocationId))) {
    throw new Error(`测试 Invocation 不存在（id=${locator.invocationId}）`);
  }
  const [currentAttempt] = await tx
    .select()
    .from(invocationAttemptTable)
    .where(eq(invocationAttemptTable.id, input.attemptId))
    .for("update")
    .limit(1);
  if (!currentAttempt) throw new Error(`测试 Attempt 不存在（id=${input.attemptId}）`);
  const [binding] = await tx
    .select()
    .from(executionBindingTable)
    .where(eq(executionBindingTable.invocationId, locator.invocationId))
    .limit(1);
  const [invocation] = await tx
    .select({ inputDigest: invocationTable.inputDigest })
    .from(invocationTable)
    .where(eq(invocationTable.id, locator.invocationId))
    .limit(1);
  const defaultSource: ExecutionSourceSnapshot = {
    tenantId: locator.tenantId,
    invocationId: locator.invocationId,
    attemptId: input.attemptId,
    sourceOperationKey: `invocation:${locator.invocationId}`,
    intentType: "start",
    sourceKind:
      currentAttempt.retryReasonCode === "supervisor_handoff"
        ? "handoff"
        : currentAttempt.retryReasonCode
          ? "redispatch"
          : "initial",
    sourceRef: `invocation:${locator.invocationId}`,
    predecessor: null,
    runtimeRevisionId: binding?.runtimeRevisionId ?? `test-runtime:${input.attemptId}`,
    workspaceBindingId: binding?.workspaceBindingId ?? `test-workspace:${input.attemptId}`,
    environmentDefinitionRevisionId: binding?.environmentDefinitionRevisionId ?? null,
    bindingConfigDigest: binding?.configHash ?? `test-binding:${input.attemptId}`,
    inputDigest: invocation?.inputDigest ?? `test-input:${input.attemptId}`,
    recovery: { kind: "initial" },
  };
  const now = input.now ?? new Date();
  const existingSource = currentAttempt.preparationSourceJson
    ? assertExecutionSourceSnapshot(currentAttempt.preparationSourceJson)
    : null;
  const existingClaim =
    existingSource &&
    currentAttempt.preparationIntentKey &&
    currentAttempt.preparationRequestDigest &&
    currentAttempt.preparationClaimId &&
    currentAttempt.preparationLeaseExpiresAt &&
    currentAttempt.preparationLeaseExpiresAt > now
      ? {
          tenantId: currentAttempt.tenantId,
          invocationId: currentAttempt.invocationId,
          attemptId: currentAttempt.id,
          intentKey: currentAttempt.preparationIntentKey,
          requestDigest: currentAttempt.preparationRequestDigest,
          claimId: currentAttempt.preparationClaimId,
          source: existingSource,
        }
      : null;
  const claimed = existingClaim
    ? { disposition: "claimed" as const, claim: existingClaim }
    : await claimAttemptPreparationInTransaction(tx, {
        source: existingSource ?? defaultSource,
        claimId: randomUUID(),
        now,
      });
  if (claimed.disposition !== "claimed" || !claimed.claim) {
    throw new Error(`测试准备领取失败（id=${input.attemptId}）`);
  }
  return markAttemptPreparedInTransaction(tx, {
    ...input,
    preparationClaim: claimed.claim,
  });
}

/** 构造需要直接测试重领/失权语义的完整来源快照。 */
export function executionSourceForTest(input: {
  tenantId: string;
  invocationId: string;
  attemptId: string;
  sourceOperationKey?: string;
}): ExecutionSourceSnapshot {
  const sourceOperationKey = input.sourceOperationKey ?? `test-fixture:${input.attemptId}`;
  return {
    ...input,
    sourceOperationKey,
    intentType: "start",
    sourceKind: "initial",
    sourceRef: sourceOperationKey,
    predecessor: null,
    runtimeRevisionId: `test-runtime:${input.attemptId}`,
    workspaceBindingId: `test-workspace:${input.attemptId}`,
    environmentDefinitionRevisionId: null,
    bindingConfigDigest: `test-binding:${input.attemptId}`,
    inputDigest: `test-input:${input.attemptId}`,
    recovery: { kind: "initial" },
  };
}

/** 读取夹具已通过真实领取建立的当前 claim；不用于生产恢复逻辑。 */
export async function attemptPreparationClaimForTestInTransaction(
  tx: AttemptTx,
  attemptId: string,
) {
  const [attempt] = await tx
    .select()
    .from(invocationAttemptTable)
    .where(eq(invocationAttemptTable.id, attemptId))
    .limit(1);
  if (
    !attempt ||
    !attempt.preparationIntentKey ||
    !attempt.preparationRequestDigest ||
    !attempt.preparationSourceJson ||
    !attempt.preparationClaimId
  ) {
    throw new Error(`测试 Attempt 缺少准备领取（id=${attemptId}）`);
  }
  const source = assertExecutionSourceSnapshot(attempt.preparationSourceJson);
  if (executionSourceDigest(source) !== attempt.preparationRequestDigest) {
    throw new Error(`测试 Attempt 准备来源损坏（id=${attemptId}）`);
  }
  return {
    tenantId: attempt.tenantId,
    invocationId: attempt.invocationId,
    attemptId: attempt.id,
    intentKey: attempt.preparationIntentKey,
    requestDigest: attempt.preparationRequestDigest,
    claimId: attempt.preparationClaimId,
    source,
  };
}

export async function attemptPreparationClaimForTest(attemptId: string) {
  return db.transaction((tx) => attemptPreparationClaimForTestInTransaction(tx, attemptId));
}
