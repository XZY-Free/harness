import { randomUUID } from "node:crypto";
import { db } from "@/lib/db/client";
import { resetDatabase } from "@/lib/db/test/mysql-harness";
import { DEFAULT_TENANT_ID, ensureDefaultTenant } from "@/lib/identity/tenant-bootstrap";
import { threadItemTable, threadTable, turnTable } from "@/lib/persistence/schema/conversation";
import { invocationTable } from "@/lib/persistence/schema/executions";
import { userActionRequestTable } from "@/lib/persistence/schema/user-action-request";
import { beforeEach, describe, expect, it } from "vitest";
import { createMySqlHarnessLoopRecoveryPort } from "./mysql-recovery-port";

const TENANT_ID = DEFAULT_TENANT_ID;

async function seedActiveInvocation() {
  const threadId = randomUUID();
  const turnId = randomUUID();
  const invocationId = randomUUID();
  await db.insert(threadTable).values({
    id: threadId,
    tenantId: TENANT_ID,
    ownerUserId: "recovery-user",
  });
  await db.insert(turnTable).values({
    id: turnId,
    threadId,
    turnSequence: 1,
    triggerType: "user_message",
    turnState: "running",
  });
  await db.insert(invocationTable).values({
    id: invocationId,
    tenantId: TENANT_ID,
    threadId,
    turnId,
    jobId: null,
    invocationSequence: 1,
    invocationKind: "initial",
    executionState: "running",
    startedAt: new Date(),
  });
  return { threadId, turnId, invocationId };
}

beforeEach(async () => {
  await resetDatabase(db);
  await ensureDefaultTenant();
});

describe("MySQL Harness recovery durable input", () => {
  it("只靠数据库恢复已解析的 generic UAR 与已确认 steer guidance", async () => {
    const seeded = await seedActiveInvocation();
    const requestId = randomUUID();
    const guidanceItemId = randomUUID();
    await db.insert(userActionRequestTable).values({
      id: requestId,
      tenantId: TENANT_ID,
      threadId: seeded.threadId,
      turnId: seeded.turnId,
      invocationId: seeded.invocationId,
      harnessActionId: "action-request-input-1",
      requestType: "input",
      purpose: "collect_leave_reason",
      requestState: "resolved",
      promptJson: { prompt: "请补充请假原因" },
      inputSchemaJson: {
        type: "object",
        required: ["text"],
        properties: { text: { type: "string" } },
      },
      resolution: "submit",
      resolvedBy: "recovery-user",
      resolvedAt: new Date(),
      responseRedactedJson: { text: "家庭事务" },
    });
    await db.insert(threadItemTable).values({
      id: guidanceItemId,
      threadId: seeded.threadId,
      turnId: seeded.turnId,
      invocationId: seeded.invocationId,
      itemSequence: 1,
      itemType: "user_guidance",
      itemState: "completed",
      authorType: "user",
      contentJson: { text: "改为后天下午" },
      contentHash: "sha256:guidance",
    });

    const recovered = await createMySqlHarnessLoopRecoveryPort(TENANT_ID).load(seeded.invocationId);

    expect(recovered.observations).toEqual([
      {
        observationType: "user_input",
        summary: "用户已补充所需信息",
        sourceRefs: [`user-action:${requestId}`],
        data: {
          harnessActionId: "action-request-input-1",
          uarId: requestId,
          purpose: "collect_leave_reason",
          resolution: "submit",
          response: { text: "家庭事务" },
        },
      },
      {
        observationType: "user_input",
        summary: "用户已提供执行引导",
        sourceRefs: [`guidance-item:${guidanceItemId}`],
        data: {
          guidanceItemId,
          guidance: { text: "改为后天下午" },
        },
      },
    ]);
  });
});
