import { createHash, randomUUID } from "node:crypto";
import { type CreateArtifactInput, createArtifact } from "@/lib/capability/artifact-queries";
import { getThreadById } from "@/lib/conversations/thread-queries";
import { getFileStorageProvider } from "@/lib/files/storage-bootstrap";

export interface PersistThreadArtifactInput {
  tenantId: string;
  ownerUserId: string;
  invocationId: string;
  threadId: string;
  turnId: string;
  itemId?: string | null;
  artifactType: CreateArtifactInput["artifactType"];
  originalFilename: string;
  contentType: string;
  content: Buffer;
  visibilityScope: CreateArtifactInput["visibilityScope"];
  expiresAt?: Date | null;
}

/** 把 AI/Tool 生成的最终文件写入统一 Provider，并登记不可变 RuntimeArtifact。 */
export async function persistThreadArtifact(input: PersistThreadArtifactInput) {
  const thread = await getThreadById(input.tenantId, input.threadId);
  if (!thread || thread.ownerUserId !== input.ownerUserId || thread.lifecycleState === "deleted") {
    throw new Error("Thread 不存在或无权写入");
  }

  const artifactId = randomUUID();
  const provider = await getFileStorageProvider();
  const stored = await provider.store({
    tenantId: input.tenantId,
    ownerUserId: input.ownerUserId,
    threadId: input.threadId,
    resourceId: artifactId,
    resourceKind: "artifact",
    originalFilename: input.originalFilename,
    contentType: input.contentType,
    content: input.content,
  });

  try {
    return await createArtifact({
      id: artifactId,
      tenantId: input.tenantId,
      invocationId: input.invocationId,
      threadId: input.threadId,
      turnId: input.turnId,
      itemId: input.itemId ?? null,
      artifactType: input.artifactType,
      displayName: input.originalFilename,
      storageProvider: provider.name,
      contentRef: stored.resourceRef,
      mediaType: input.contentType,
      byteSize: input.content.byteLength,
      contentHash: `sha256:${createHash("sha256").update(input.content).digest("hex")}`,
      visibilityScope: input.visibilityScope,
      expiresAt: input.expiresAt ?? null,
    });
  } catch (error) {
    await provider
      .delete({
        tenantId: input.tenantId,
        threadId: input.threadId,
        resourceRef: stored.resourceRef,
      })
      .catch(() => false);
    throw error;
  }
}
