import { db } from "@/lib/db/client";
import { completeIdempotencyRecord } from "@/lib/identity/idempotency-queries";
import {
  type CreateManagedWorkspaceAttachmentInput,
  createManagedWorkspaceAttachment,
} from "@/lib/workspace/workspace-queries";

export interface AttachmentIdempotencyCompletion {
  recordId: string;
  responseBody: Record<string, unknown>;
}

/**
 * 在一个数据库事务中登记原文件元数据并完成幂等记录。
 * 文件字节在事务前写入 Provider；本事务失败时由调用方删除对应字节。
 */
export async function commitManagedWorkspaceAttachment(
  attachment: CreateManagedWorkspaceAttachmentInput,
  idempotency: AttachmentIdempotencyCompletion,
) {
  return db.transaction(async (tx) => {
    const created = await createManagedWorkspaceAttachment(attachment, tx);
    const completed = await completeIdempotencyRecord(
      {
        recordId: idempotency.recordId,
        httpStatus: 201,
        responseRef: attachment.id,
        responseRedactedJson: JSON.stringify(idempotency.responseBody),
      },
      tx,
    );
    if (!completed) {
      throw new Error("附件幂等记录已不再处于 processing 状态");
    }
    return created;
  });
}
