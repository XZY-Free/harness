import { randomUUID } from "node:crypto";
import { rm } from "node:fs/promises";
import { resolve } from "node:path";
import { seedAgentCallExecutionScenario } from "@/lib/agents/calls/test/agent-call-execution-fixtures";
import { db } from "@/lib/db/client";
import { resetDatabase } from "@/lib/db/test/mysql-harness";
import { workspaceFileStorageProvider } from "@/lib/files/workspace-storage-provider";
import { threadTable } from "@/lib/persistence/schema/conversation";
import {
  createManagedWorkspaceAttachment,
  createWorkspaceAttachmentUse,
  detachWorkspaceAttachment,
} from "@/lib/workspace/workspace-queries";
import { eq } from "drizzle-orm";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { createAgentAttachmentReferences, readAgentAttachment } from "./agent-attachment-access";

const TEST_ROOT = resolve(".test-agent-attachment-workspaces");
const originalRoot = process.env.SNOW_WORKSPACES_DIR;
let scenarios: Awaited<ReturnType<typeof seedAgentCallExecutionScenario>>[] = [];

beforeEach(async () => {
  process.env.SNOW_WORKSPACES_DIR = TEST_ROOT;
  await resetDatabase(db);
  await rm(TEST_ROOT, { recursive: true, force: true });
  scenarios = [];
});

afterEach(async () => {
  for (const scenario of scenarios) {
    delete process.env[scenario.credentialEnvVar];
    await scenario.provider.close();
  }
  process.env.SNOW_WORKSPACES_DIR = originalRoot;
  await rm(TEST_ROOT, { recursive: true, force: true });
});

async function seedAttachment() {
  const scenario = await seedAgentCallExecutionScenario({ providerScenario: "long_running" });
  scenarios.push(scenario);
  const [thread] = await db
    .select()
    .from(threadTable)
    .where(eq(threadTable.id, scenario.threadId))
    .limit(1);
  if (!thread) throw new Error("测试 Thread 不存在");
  const attachmentId = randomUUID();
  const content = Buffer.from("private employee document bytes");
  const stored = await workspaceFileStorageProvider.store({
    tenantId: scenario.tenantId,
    ownerUserId: thread.ownerUserId,
    threadId: scenario.threadId,
    resourceId: attachmentId,
    resourceKind: "attachment",
    originalFilename: "病假证明.pdf",
    contentType: "application/pdf",
    content,
  });
  const attachment = await createManagedWorkspaceAttachment({
    id: attachmentId,
    tenantId: scenario.tenantId,
    threadId: scenario.threadId,
    storageProvider: workspaceFileStorageProvider.name,
    resourceRef: stored.resourceRef,
    resourceFingerprint: `sha256:${await crypto.subtle
      .digest("SHA-256", content)
      .then((digest) => Buffer.from(digest).toString("hex"))}`,
    originalFilename: "病假证明.pdf",
    contentType: "application/pdf",
    sizeBytes: content.byteLength,
    attachedBy: thread.ownerUserId,
  });
  await createWorkspaceAttachmentUse({
    tenantId: scenario.tenantId,
    turnId: scenario.turnId,
    workspaceAttachmentId: attachment.id,
  });
  return { scenario, attachment, content };
}

describe("Agent 附件访问授权", () => {
  it("只把显式选择的 Turn 附件投影为短期公共引用并可读取原文件", async () => {
    const { scenario, attachment, content } = await seedAttachment();

    const references = await createAgentAttachmentReferences({
      tenantId: scenario.tenantId,
      threadId: scenario.threadId,
      turnId: scenario.turnId,
      invocationId: scenario.parentInvocationId,
      agentCallId: scenario.callId,
      selectedContextRefs: [`attachment:${attachment.id}`],
      expiresAt: new Date(Date.now() + 60_000),
    });

    expect(references).toEqual([
      {
        reference_id: expect.stringMatching(/^[0-9a-f-]{36}$/),
        resource_type: "file",
        display_name: "病假证明.pdf",
        media_type: "application/pdf",
      },
    ]);
    expect(references[0]?.reference_id).not.toContain(attachment.resourceRef);
    await expect(readAgentAttachment(references[0]?.reference_id ?? "")).resolves.toMatchObject({
      content,
      originalFilename: "病假证明.pdf",
      contentType: "application/pdf",
    });
  });

  it("未被 Turn 使用、已卸载或过期的引用全部失败关闭", async () => {
    const { scenario, attachment } = await seedAttachment();
    const references = await createAgentAttachmentReferences({
      tenantId: scenario.tenantId,
      threadId: scenario.threadId,
      turnId: scenario.turnId,
      invocationId: scenario.parentInvocationId,
      agentCallId: scenario.callId,
      selectedContextRefs: [`attachment:${attachment.id}`],
      expiresAt: new Date(Date.now() + 60_000),
    });
    await detachWorkspaceAttachment(scenario.tenantId, attachment.id, attachment.versionNo);

    await expect(readAgentAttachment(references[0]?.reference_id ?? "")).rejects.toThrow(
      "附件引用不存在或不可用",
    );
    await expect(
      createAgentAttachmentReferences({
        tenantId: scenario.tenantId,
        threadId: scenario.threadId,
        turnId: scenario.turnId,
        invocationId: scenario.parentInvocationId,
        agentCallId: scenario.callId,
        selectedContextRefs: [`attachment:${randomUUID()}`],
        expiresAt: new Date(Date.now() + 60_000),
      }),
    ).rejects.toThrow("附件未绑定当前 Turn");
  });

  it("同一 AgentCall 并发申请同一附件时复用一个授权", async () => {
    const { scenario, attachment } = await seedAttachment();
    const input = {
      tenantId: scenario.tenantId,
      threadId: scenario.threadId,
      turnId: scenario.turnId,
      invocationId: scenario.parentInvocationId,
      agentCallId: scenario.callId,
      selectedContextRefs: [`attachment:${attachment.id}`],
      expiresAt: new Date(Date.now() + 60_000),
    };

    const results = await Promise.all(
      Array.from({ length: 12 }, () => createAgentAttachmentReferences(input)),
    );

    expect(new Set(results.map((references) => references[0]?.reference_id))).toHaveLength(1);
  });

  it("拒绝仅满足长度但不是 UUID 的附件选择", async () => {
    const { scenario } = await seedAttachment();

    await expect(
      createAgentAttachmentReferences({
        tenantId: scenario.tenantId,
        threadId: scenario.threadId,
        turnId: scenario.turnId,
        invocationId: scenario.parentInvocationId,
        agentCallId: scenario.callId,
        selectedContextRefs: ["attachment:------------------------------------"],
        expiresAt: new Date(Date.now() + 60_000),
      }),
    ).rejects.toThrow("Agent 附件引用格式非法");
  });
});
