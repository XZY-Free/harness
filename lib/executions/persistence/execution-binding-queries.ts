import { db } from "@/lib/db/client";
import {
  type ExecutionBindingRow,
  executionBindingTable,
} from "@/lib/persistence/schema/executions";
import { and, eq } from "drizzle-orm";

/** 按 Invocation 读取不可变 ExecutionBinding，并强制租户隔离。 */
export async function getExecutionBindingByInvocation(
  tenantId: string,
  invocationId: string,
): Promise<ExecutionBindingRow | null> {
  const [row] = await db
    .select()
    .from(executionBindingTable)
    .where(
      and(
        eq(executionBindingTable.tenantId, tenantId),
        eq(executionBindingTable.invocationId, invocationId),
      ),
    )
    .limit(1);
  return row ?? null;
}
