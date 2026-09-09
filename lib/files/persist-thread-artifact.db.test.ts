import { randomUUID } from "node:crypto";
import { rm } from "node:fs/promises";
import { resolve } from "node:path";
import { getArtifactById } from "@/lib/capability/artifact-queries";
import { createThread } from "@/lib/conversations/thread-queries";
import { db } from "@/lib/db/client";
import { resetDatabase } from "@/lib/db/test/mysql-harness";
import { workspaceFileStorageProvider } from "@/lib/files/workspace-storage-provider";
import { ensureDefaultTenant } from "@/lib/identity/tenant-queries";
import { upsertUserIdentity } from "@/lib/identity/user-identity-queries";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { persistThreadArtifact } from "./persist-thread-artifact";

const TEST_ROOT = resolve(".test-artifact-workspaces");
const originalRoot = process.env.SNOW_WORKSPACES_DIR;

beforeEach(async () => {
  process.env.SNOW_WORKSPACES_DIR = TEST_ROOT;
  await resetDatabase(db);
  await rm(TEST_ROOT, { recursive: true, force: true });
});

afterEach(async () => {
  process.env.SNOW_WORKSPACES_DIR = originalRoot;
  await rm(TEST_ROOT, { recursive: true, force: true });
});

describe("AI 生成文件进入统一文件存储", () => {
  it("保存原始字节并登记可追溯 RuntimeArtifact", async () => {
    const tenant = await ensureDefaultTenant();
    const user = await upsertUserIdentity({
      tenantId: tenant.id,
      externalSubject: "artifact-owner",
      email: "artifact-owner@example.test",
      displayName: "产物用户",
    });
    const { thread } = await createThread({
      tenantId: tenant.id,
      ownerUserId: user.id,
      actorId: user.id,
      title: "生成文件会话",
    });
    const content = Buffer.from("final generated workbook bytes");
    const invocationId = randomUUID();

    const artifact = await persistThreadArtifact({
      tenantId: tenant.id,
      ownerUserId: user.id,
      invocationId,
      threadId: thread.id,
      turnId: randomUUID(),
      artifactType: "report",
      originalFilename: "员工报表.xlsx",
      contentType: "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
      content,
      visibilityScope: "thread",
    });

    expect(artifact).toMatchObject({
      tenantId: tenant.id,
      invocationId,
      threadId: thread.id,
      artifactType: "report",
      displayName: "员工报表.xlsx",
      mediaType: "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
      byteSize: content.byteLength,
      storageProvider: "workspace",
      visibilityScope: "thread",
    });
    expect(artifact.contentRef).toBe(`.snow/files/artifact/${artifact.id}/content`);
    expect(artifact.contentHash).toMatch(/^sha256:[0-9a-f]{64}$/);
    await expect(getArtifactById(tenant.id, artifact.id)).resolves.toMatchObject({
      id: artifact.id,
      storageProvider: "workspace",
    });
    await expect(
      workspaceFileStorageProvider.read({
        tenantId: tenant.id,
        threadId: thread.id,
        resourceRef: artifact.contentRef,
      }),
    ).resolves.toEqual(content);
  });

  it("Thread 不属于给定用户时在写文件前拒绝", async () => {
    const tenant = await ensureDefaultTenant();
    const user = await upsertUserIdentity({
      tenantId: tenant.id,
      externalSubject: "artifact-owner-a",
      email: "artifact-owner-a@example.test",
      displayName: "产物用户 A",
    });
    const { thread } = await createThread({
      tenantId: tenant.id,
      ownerUserId: user.id,
      actorId: user.id,
      title: "A 的会话",
    });

    await expect(
      persistThreadArtifact({
        tenantId: tenant.id,
        ownerUserId: randomUUID(),
        invocationId: randomUUID(),
        threadId: thread.id,
        turnId: randomUUID(),
        artifactType: "file",
        originalFilename: "forbidden.txt",
        contentType: "text/plain",
        content: Buffer.from("must not persist"),
        visibilityScope: "thread",
      }),
    ).rejects.toThrow("Thread 不存在或无权写入");
  });
});
