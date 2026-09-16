/** Caller-owned recovery queries：必须在调用方事务内执行，禁止全局 db 版本。 */
import type { RuntimeSessionBinding } from "@/lib/persistence/schema/executions";
import { runtimeSessionBindingTable } from "@/lib/persistence/schema/executions";
import {
  type SessionTx,
  markRuntimeSessionLostInTransaction,
} from "@/lib/runtime/persistence/runtime-session-store";
import { and, eq } from "drizzle-orm";

/**
 * 在调用方事务内把指定 Invocation 的 SessionBinding 标记为 lost。
 *
 * 与 markInvocationLost 同一串行化范围使用（caller-owned 事务内版本），
 * 禁止在此之外引入全局 db 连接版本（markSessionBindingLost）。
 */
export async function markSessionBindingLostInSession(
  executor: SessionTx,
  input: { tenantId: string; invocationId: string; ownershipId: string },
): Promise<RuntimeSessionBinding | null> {
  const [session] = await executor
    .select()
    .from(runtimeSessionBindingTable)
    .where(
      and(
        eq(runtimeSessionBindingTable.tenantId, input.tenantId),
        eq(runtimeSessionBindingTable.invocationId, input.invocationId),
        eq(runtimeSessionBindingTable.ownershipId, input.ownershipId),
      ),
    )
    .for("update")
    .limit(1);
  if (!session) return null;
  return markRuntimeSessionLostInTransaction(executor, session.id);
}
