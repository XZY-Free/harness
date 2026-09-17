/**
 * InvocationCommand 只读回读。
 *
 * 控制面响应里的 `command.command_state` **必须**是持久事实，不能是派发前的内存快照：
 * 派发可能已经把命令推进到 `acknowledged` / `failed`（例如冻结目标失效 →
 * `CommandTargetSuperseded` 终态）。写入口在 `command-dispatcher` 与命令网关；
 * 本模块只提供读，不提供任何状态写入。
 */
import { db } from "@/lib/db/client";
import type { InvocationCommand } from "@/lib/persistence/schema/executions";
import { invocationCommandTable } from "@/lib/persistence/schema/executions";
import { and, eq } from "drizzle-orm";

export async function getInvocationCommandById(
  tenantId: string,
  commandId: string,
): Promise<InvocationCommand | null> {
  const [row] = await db
    .select()
    .from(invocationCommandTable)
    .where(
      and(eq(invocationCommandTable.tenantId, tenantId), eq(invocationCommandTable.id, commandId)),
    )
    .limit(1);
  return row ?? null;
}
