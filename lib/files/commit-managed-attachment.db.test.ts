import { randomUUID } from "node:crypto";
import { createThread } from "@/lib/conversations/thread-queries";
import { db } from "@/lib/db/client";
import { resetDatabase } from "@/lib/db/test/mysql-harness";
import {
  getIdempotencyRecordById,
  insertProcessingRecord,
} from "@/lib/identity/idempotency-queries";
import { ensureDefaultTenant } from "@/lib/identity/tenant-queries";
import { upsertUserIdentity } from "@/lib/identity/user-identity-queries";
import { getWorkspaceAttachmentById } from "@/lib/workspace/workspace-queries";
import { beforeEach, describe, expect, it } from "vitest";
import { commitManagedWorkspaceAttachment } from "./commit-managed-attachment";

beforeEach(async () => {
  await resetDatabase(db);
});

async function fixture() {
  const tenant = await ensureDefaultTenant();
  const user = await upsertUserIdentity({
    tenantId: tenant.id,
    externalSubject: `attachment-owner-${randomUUID()}`,
    email: `${randomUUID()}@example.test`,
    displayName: "附件用户",
  });
  const { thread } = await createThread({
    tenantId: tenant.id,
    ownerUserId: user.id,
    actorId: user.id,
    title: "附件会话",
  });
  const attachmentId = randomUUID();
  return {
    tenant,
    user,
    thread,
    attachmentId,
    attachment: {
      id: attachmentId,
      tenantId: tenant.id,
      threadId: thread.id,
      storageProvider: "workspace",
      resourceRef: `.snow/files/attachment/${attachmentId}/content`,
      resourceFingerprint: `sha256:${"a".repeat(64)}`,
      originalFilename: "证明材料.pdf",
      contentType: "application/pdf",
      sizeBytes: 1234,
      attachedBy: user.id,
    },
  };
}

describe("附件元数据与幂等账本事务", () => {
  it("同时提交附件事实和可重放响应", async () => {
    const f = await fixture();
    const record = await insertProcessingRecord({
      tenantId: f.tenant.id,
      audience: "employee",
      callerType: "user",
      callerId: f.user.id,
      commandScope: `thread.attachment.create:${f.thread.id}`,
      idempotencyKey: "upload-proof-1",
      requestHash: "a".repeat(64),
    });
    const responseBody = {
      kind: "attachment",
      attachment_id: f.attachmentId,
      url: `/api/v1/threads/${f.thread.id}/attachments/${f.attachmentId}`,
      filename: "证明材料.pdf",
      size: 1234,
      type: "application/pdf",
    };

    await commitManagedWorkspaceAttachment(f.attachment, {
      recordId: record.id,
      responseBody,
    });

    await expect(getWorkspaceAttachmentById(f.tenant.id, f.attachmentId)).resolves.toMatchObject({
      id: f.attachmentId,
      storageProvider: "workspace",
    });
    await expect(getIdempotencyRecordById(record.id)).resolves.toMatchObject({
      processingState: "completed",
      httpStatus: 201,
      responseRef: f.attachmentId,
      responseRedactedJson: JSON.stringify(responseBody),
    });
  });

  it("幂等记录无法完成时回滚附件元数据", async () => {
    const f = await fixture();

    await expect(
      commitManagedWorkspaceAttachment(f.attachment, {
        recordId: randomUUID(),
        responseBody: { attachment_id: f.attachmentId },
      }),
    ).rejects.toThrow("附件幂等记录已不再处于 processing 状态");

    await expect(getWorkspaceAttachmentById(f.tenant.id, f.attachmentId)).resolves.toBeNull();
  });
});
