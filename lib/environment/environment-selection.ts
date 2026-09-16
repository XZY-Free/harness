import { randomUUID } from "node:crypto";
import { db } from "@/lib/db/client";
import {
  ENVIRONMENT_CHANGE_REQUEST_STATES,
  environmentChangeRequestTable,
} from "@/lib/persistence/schema/environment";
import { and, asc, eq } from "drizzle-orm";

export async function requestEnvironmentSelection(input: {
  tenantId: string;
  threadId: string;
  requestedRevisionId: string;
  requestedBy: string;
  reasonCode?: string | null;
  expiresAt?: Date | null;
}) {
  const [latest] = await db
    .select({ sequence: environmentChangeRequestTable.selectionSequence })
    .from(environmentChangeRequestTable)
    .where(
      and(
        eq(environmentChangeRequestTable.tenantId, input.tenantId),
        eq(environmentChangeRequestTable.threadId, input.threadId),
      ),
    )
    .orderBy(asc(environmentChangeRequestTable.selectionSequence))
    .limit(1);
  const id = randomUUID();
  await db.insert(environmentChangeRequestTable).values({
    id,
    tenantId: input.tenantId,
    threadId: input.threadId,
    selectionSequence: (latest?.sequence ?? 0) + 1,
    requestedRevisionId: input.requestedRevisionId,
    requestState: "accepted_for_next_invocation",
    requestedBy: input.requestedBy,
    reasonCode: input.reasonCode ?? null,
    firstAppliedInvocationId: null,
    expiresAt: input.expiresAt ?? null,
    versionNo: 1,
  });
  const [row] = await db
    .select()
    .from(environmentChangeRequestTable)
    .where(eq(environmentChangeRequestTable.id, id))
    .limit(1);
  return row;
}

export async function getPendingEnvironmentSelection(tenantId: string, threadId: string) {
  const [row] = await db
    .select()
    .from(environmentChangeRequestTable)
    .where(
      and(
        eq(environmentChangeRequestTable.tenantId, tenantId),
        eq(environmentChangeRequestTable.threadId, threadId),
        eq(environmentChangeRequestTable.requestState, "accepted_for_next_invocation"),
      ),
    )
    .orderBy(asc(environmentChangeRequestTable.selectionSequence))
    .limit(1);
  return row ?? null;
}
