import { db } from "@/lib/db/client";
import {
 type RuntimeRevisionRow,
 runtimeRevisionTable,
} from "@/lib/persistence/schema/control-plane";
import {
 RuntimeRevisionNotFoundError,
 RuntimeRevisionStateError,
} from "@/lib/runtime/domain/runtime-revision-publication-policy";
import { eq } from "drizzle-orm";

/** 仅供旧集成测试构造 withdrawn 历史状态。 */
export async function withdrawRuntimeRevision(revisionId: string): Promise<RuntimeRevisionRow> {
 const [current] = await db
 .select()
 .from(runtimeRevisionTable)
 .where(eq(runtimeRevisionTable.id, revisionId))
 .limit(1);
 if (!current) throw new RuntimeRevisionNotFoundError(revisionId);
 if (current.revisionState !== "published") {
 throw new RuntimeRevisionStateError(
 revisionId,
 current.revisionState,
 "withdrawn",
 "只有 published 状态可撤回",
 );
 }

 await db
 .update(runtimeRevisionTable)
 .set({ revisionState: "withdrawn" })
 .where(eq(runtimeRevisionTable.id, revisionId));
 const [withdrawn] = await db
 .select()
 .from(runtimeRevisionTable)
 .where(eq(runtimeRevisionTable.id, revisionId))
 .limit(1);
 if (!withdrawn) throw new RuntimeRevisionNotFoundError(revisionId);
 return withdrawn;
}
