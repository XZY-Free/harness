import { type DbOrTx, db } from "@/lib/db/client";
import {
  type FilesystemCheckpoint,
  filesystemCheckpointTable,
} from "@/lib/persistence/schema/filesystem-checkpoint";
import { and, asc, eq } from "drizzle-orm";

export async function getFilesystemCheckpoint(
  tenantId: string,
  checkpointId: string,
  executor: DbOrTx = db,
): Promise<FilesystemCheckpoint | null> {
  const [row] = await executor
    .select()
    .from(filesystemCheckpointTable)
    .where(
      and(
        eq(filesystemCheckpointTable.tenantId, tenantId),
        eq(filesystemCheckpointTable.id, checkpointId),
      ),
    )
    .limit(1);
  return row ?? null;
}

export async function getFilesystemCheckpointByIntent(
  tenantId: string,
  invocationId: string,
  checkpointIntentId: string,
  executor: DbOrTx = db,
): Promise<FilesystemCheckpoint | null> {
  const [row] = await executor
    .select()
    .from(filesystemCheckpointTable)
    .where(
      and(
        eq(filesystemCheckpointTable.tenantId, tenantId),
        eq(filesystemCheckpointTable.invocationId, invocationId),
        eq(filesystemCheckpointTable.checkpointIntentId, checkpointIntentId),
      ),
    )
    .limit(1);
  return row ?? null;
}

export async function listFilesystemCheckpoints(
  tenantId: string,
  invocationId: string,
  executor: DbOrTx = db,
): Promise<FilesystemCheckpoint[]> {
  return executor
    .select()
    .from(filesystemCheckpointTable)
    .where(
      and(
        eq(filesystemCheckpointTable.tenantId, tenantId),
        eq(filesystemCheckpointTable.invocationId, invocationId),
      ),
    )
    .orderBy(
      asc(filesystemCheckpointTable.recoveryVersion),
      asc(filesystemCheckpointTable.committedAt),
    );
}

export async function insertFilesystemCheckpoint(
  executor: DbOrTx,
  input: Omit<FilesystemCheckpoint, "createdAt" | "updatedAt">,
): Promise<FilesystemCheckpoint> {
  await executor.insert(filesystemCheckpointTable).values(input);
  const row = await getFilesystemCheckpoint(input.tenantId, input.id, executor);
  if (!row) throw new Error("FilesystemCheckpoint 写入后无法读取");
  return row;
}
