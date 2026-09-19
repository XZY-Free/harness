import { type DbOrTx, db } from "@/lib/db/client";
import { environmentDefinitionTable } from "@/lib/persistence/schema/environment";
import {
  type EnvironmentDefinitionRevision,
  environmentDefinitionRevisionTable,
} from "@/lib/persistence/schema/environment-definition-revision";
import { and, asc, desc, eq, ne } from "drizzle-orm";
import { type EnvironmentRevisionInput, validateEnvironmentRevision } from "./environment-revision";

/**
 * A01-03：本模块**多语句**操作的强制事务类型。
 *
 * 定义/版本的创建都是"锁 Definition 行 → 校验版本 → INSERT Revision → 回写 currentRevisionId
 * → 回读"，这类操作不接受全局 `db`（否则每条语句各自 autocommit，If-Match 版本校验会退化成竞态）。
 */
export type EnvironmentDefinitionTx = Parameters<Parameters<typeof db.transaction>[0]>[0];

export class EnvironmentValidationError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "EnvironmentValidationError";
  }
}
export class EnvironmentNotFoundError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "EnvironmentNotFoundError";
  }
}
export class EnvironmentVersionConflictError extends Error {
  constructor(
    message: string,
    public readonly expectedVersionNo: number,
    public readonly actualVersionNo: number,
  ) {
    super(message);
    this.name = "EnvironmentVersionConflictError";
  }
}

export interface CreateEnvironmentDefinitionInput {
  tenantId: string;
  environmentKey: string;
  displayName: string;
  description?: string | null;
  revision: EnvironmentRevisionInput;
}

export async function createEnvironmentDefinition(input: CreateEnvironmentDefinitionInput) {
  if (!/^[A-Za-z][A-Za-z0-9_-]{0,127}$/.test(input.environmentKey))
    throw new EnvironmentValidationError("environmentKey 格式非法");
  if (!input.displayName.trim()) throw new EnvironmentValidationError("displayName 不能为空");
  const revision = validateEnvironmentRevision(input.revision);
  return db.transaction(async (tx) => {
    const definitionId = crypto.randomUUID();
    await tx.insert(environmentDefinitionTable).values({
      id: definitionId,
      tenantId: input.tenantId,
      environmentKey: input.environmentKey,
      displayName: input.displayName,
      description: input.description ?? null,
      lifecycleState: "active",
      currentRevisionId: null,
      lastRevisionNo: 0,
      versionNo: 1,
      deletedAt: null,
    });
    const createdRevision = await createEnvironmentRevisionInTransaction(
      tx,
      input.tenantId,
      definitionId,
      revision,
    );
    await tx
      .update(environmentDefinitionTable)
      .set({
        currentRevisionId: createdRevision.id,
        lastRevisionNo: createdRevision.revisionNo,
        versionNo: 2,
        updatedAt: new Date(),
      })
      .where(eq(environmentDefinitionTable.id, definitionId));
    const [definition] = await tx
      .select()
      .from(environmentDefinitionTable)
      .where(eq(environmentDefinitionTable.id, definitionId))
      .limit(1);
    if (!definition) throw new EnvironmentNotFoundError("EnvironmentDefinition 创建后回查失败");
    return definition;
  });
}

export async function getEnvironmentDefinitionById(
  tenantId: string,
  id: string,
  executor: DbOrTx = db,
) {
  const [row] = await executor
    .select()
    .from(environmentDefinitionTable)
    .where(
      and(eq(environmentDefinitionTable.tenantId, tenantId), eq(environmentDefinitionTable.id, id)),
    )
    .limit(1);
  return row ?? null;
}

export async function getEnvironmentDefinitionByKey(
  tenantId: string,
  key: string,
  executor: DbOrTx = db,
) {
  const [row] = await executor
    .select()
    .from(environmentDefinitionTable)
    .where(
      and(
        eq(environmentDefinitionTable.tenantId, tenantId),
        eq(environmentDefinitionTable.environmentKey, key),
      ),
    )
    .limit(1);
  return row ?? null;
}

export async function listEnvironmentDefinitions(
  tenantId: string,
  options?: { lifecycleState?: "active" | "archived" | "deleted"; limit?: number },
) {
  const conditions = [eq(environmentDefinitionTable.tenantId, tenantId)];
  if (options?.lifecycleState)
    conditions.push(eq(environmentDefinitionTable.lifecycleState, options.lifecycleState));
  else conditions.push(ne(environmentDefinitionTable.lifecycleState, "deleted"));
  return db
    .select()
    .from(environmentDefinitionTable)
    .where(and(...conditions))
    .orderBy(asc(environmentDefinitionTable.environmentKey))
    .limit(options?.limit ?? 100);
}

export async function archiveEnvironmentDefinition(
  tenantId: string,
  id: string,
  expectedVersionNo: number,
) {
  return db.transaction(async (tx) => {
    const [current] = await tx
      .select()
      .from(environmentDefinitionTable)
      .where(
        and(
          eq(environmentDefinitionTable.tenantId, tenantId),
          eq(environmentDefinitionTable.id, id),
        ),
      )
      .for("update")
      .limit(1);
    if (!current) throw new EnvironmentNotFoundError(id);
    if (current.versionNo !== expectedVersionNo)
      throw new EnvironmentVersionConflictError(
        "EnvironmentDefinition 版本冲突",
        expectedVersionNo,
        current.versionNo,
      );
    await tx
      .update(environmentDefinitionTable)
      .set({ lifecycleState: "archived", versionNo: current.versionNo + 1, updatedAt: new Date() })
      .where(
        and(
          eq(environmentDefinitionTable.tenantId, tenantId),
          eq(environmentDefinitionTable.id, id),
        ),
      );
    const [updated] = await tx
      .select()
      .from(environmentDefinitionTable)
      .where(
        and(
          eq(environmentDefinitionTable.tenantId, tenantId),
          eq(environmentDefinitionTable.id, id),
        ),
      )
      .limit(1);
    if (!updated) throw new EnvironmentNotFoundError(id);
    return updated;
  });
}

export async function createEnvironmentRevisionInTransaction(
  tx: EnvironmentDefinitionTx,
  tenantId: string,
  definitionId: string,
  input: EnvironmentRevisionInput,
  options?: { expectedVersionNo?: number },
): Promise<EnvironmentDefinitionRevision> {
  const [definition] = await tx
    .select()
    .from(environmentDefinitionTable)
    .where(
      and(
        eq(environmentDefinitionTable.tenantId, tenantId),
        eq(environmentDefinitionTable.id, definitionId),
      ),
    )
    .for("update")
    .limit(1);
  if (!definition || definition.lifecycleState !== "active")
    throw new EnvironmentNotFoundError(definitionId);
  // If-Match 乐观并发：携带 expectedVersionNo 的编辑在行锁内校验 Definition 版本，冲突方失败。
  if (
    options?.expectedVersionNo !== undefined &&
    definition.versionNo !== options.expectedVersionNo
  ) {
    throw new EnvironmentVersionConflictError(
      "EnvironmentDefinition 版本冲突",
      options.expectedVersionNo,
      definition.versionNo,
    );
  }
  const revision = validateEnvironmentRevision(input);
  const revisionNo = definition.lastRevisionNo + 1;
  const id = crypto.randomUUID();
  await tx
    .insert(environmentDefinitionRevisionTable)
    .values({ id, tenantId, definitionId, revisionNo, ...revision });
  const [row] = await tx
    .select()
    .from(environmentDefinitionRevisionTable)
    .where(eq(environmentDefinitionRevisionTable.id, id))
    .limit(1);
  if (!row) throw new EnvironmentNotFoundError("EnvironmentDefinitionRevision 创建后回查失败");
  await tx
    .update(environmentDefinitionTable)
    .set({
      currentRevisionId: id,
      lastRevisionNo: revisionNo,
      versionNo: definition.versionNo + 1,
      updatedAt: new Date(),
    })
    .where(eq(environmentDefinitionTable.id, definitionId));
  return row;
}

export async function createEnvironmentRevision(
  tenantId: string,
  definitionId: string,
  input: EnvironmentRevisionInput,
  options?: { expectedVersionNo?: number },
) {
  return db.transaction((tx) =>
    createEnvironmentRevisionInTransaction(tx, tenantId, definitionId, input, options),
  );
}

export async function getEnvironmentRevisionById(
  tenantId: string,
  id: string,
  executor: DbOrTx = db,
) {
  const [row] = await executor
    .select()
    .from(environmentDefinitionRevisionTable)
    .where(
      and(
        eq(environmentDefinitionRevisionTable.tenantId, tenantId),
        eq(environmentDefinitionRevisionTable.id, id),
      ),
    )
    .limit(1);
  return row ?? null;
}

export async function listEnvironmentRevisions(tenantId: string, definitionId: string) {
  return db
    .select()
    .from(environmentDefinitionRevisionTable)
    .where(
      and(
        eq(environmentDefinitionRevisionTable.tenantId, tenantId),
        eq(environmentDefinitionRevisionTable.definitionId, definitionId),
      ),
    )
    .orderBy(desc(environmentDefinitionRevisionTable.revisionNo));
}
