/** Creates a durable InvocationCommand and snapshots the current authority target. */
import { randomUUID } from "node:crypto";
import type { OwnershipTx } from "@/lib/executions/persistence/execution-ownership-store";
import {
  executionOwnershipTable,
  invocationCommandTable,
  runtimeSessionBindingTable,
} from "@/lib/persistence/schema/executions";
import { protocolDigest } from "@/lib/runtime/runtime-protocol";
import { and, eq } from "drizzle-orm";

export interface CreateInvocationCommandInput {
  tenantId: string;
  invocationId: string;
  commandType: "cancel" | "resume" | "steer" | "checkpoint";
  idempotencyKey: string;
  payloadJson: unknown;
  requestedByType: "user" | "service" | "system";
  requestedById: string;
  commandId?: string;
}

/**
 * A01-03：多语句（父 Owner 锁定 + Session 目标快照 + INSERT），**必须**在调用方事务内执行。
 * 参数类型是真实事务类型，禁止传入全局 `db` 造成逐语句隐式 autocommit。
 */
export async function createInvocationCommandInTransaction(
  tx: OwnershipTx,
  input: CreateInvocationCommandInput,
): Promise<string> {
  const [owner] = await tx
    .select({ id: executionOwnershipTable.id })
    .from(executionOwnershipTable)
    .where(
      and(
        eq(executionOwnershipTable.tenantId, input.tenantId),
        eq(executionOwnershipTable.invocationId, input.invocationId),
        eq(executionOwnershipTable.ownershipState, "active"),
      ),
    )
    .for("update")
    .limit(1);
  const [session] = owner
    ? await tx
        .select({ id: runtimeSessionBindingTable.id })
        .from(runtimeSessionBindingTable)
        .where(
          and(
            eq(runtimeSessionBindingTable.tenantId, input.tenantId),
            eq(runtimeSessionBindingTable.ownershipId, owner.id),
          ),
        )
        .limit(1)
    : [];
  const id = input.commandId ?? randomUUID();
  await tx.insert(invocationCommandTable).values({
    id,
    tenantId: input.tenantId,
    invocationId: input.invocationId,
    commandType: input.commandType,
    commandState: "queued",
    idempotencyKey: input.idempotencyKey,
    payloadJson: input.payloadJson,
    payloadDigest: protocolDigest(input.payloadJson),
    targetOwnershipId: owner?.id ?? null,
    targetSessionId: session?.id ?? null,
    requestedByType: input.requestedByType,
    requestedById: input.requestedById,
    dispatchCount: 0,
    nextDispatchAt: null,
    dispatchLeaseOwner: null,
    dispatchLeaseExpiresAt: null,
    receiptJson: null,
    lastErrorCode: null,
    completedAt: null,
    versionNo: 1,
  });
  return id;
}
