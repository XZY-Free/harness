import { randomUUID } from "node:crypto";
import { createThread } from "@/lib/conversations/thread-queries";
import { db } from "@/lib/db/client";
import { resetDatabase } from "@/lib/db/test/mysql-harness";
import { ensureDefaultTenant } from "@/lib/identity/tenant-queries";
import { upsertUserIdentity } from "@/lib/identity/user-identity-queries";
import {
  createManagedWorkspaceAttachment,
  getWorkspaceAttachmentById,
} from "@/lib/workspace/workspace-queries";
import { beforeEach, describe, expect, it } from "vitest";

beforeEach(async () => {
  await resetDatabase(db);
});

describe("受管附件存储事实", () => {
  it("无需 WorkspaceBinding 即可登记 Provider 原文件并保持租户隔离", async () => {
    const tenant = await ensureDefaultTenant();
    const user = await upsertUserIdentity({
      tenantId: tenant.id,
      externalSubject: "attachment-owner",
      email: "attachment-owner@example.test",
      displayName: "附件用户",
    });
    const { thread } = await createThread({
      tenantId: tenant.id,
      ownerUserId: user.id,
      actorId: user.id,
      title: "附件会话",
    });
    const attachmentId = randomUUID();

    const created = await createManagedWorkspaceAttachment({
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
    });

    expect(created).toMatchObject({
      id: attachmentId,
      tenantId: tenant.id,
      threadId: thread.id,
      workspaceBindingId: null,
      storageProvider: "workspace",
      resourceType: "file",
      resourceRef: `.snow/files/attachment/${attachmentId}/content`,
      resourceFingerprint: `sha256:${"a".repeat(64)}`,
      originalFilename: "证明材料.pdf",
      contentType: "application/pdf",
      sizeBytes: 1234,
      attachmentState: "attached",
      attachedBy: user.id,
    });
    await expect(getWorkspaceAttachmentById(randomUUID(), attachmentId)).resolves.toBeNull();
  });
});
