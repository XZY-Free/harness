import { randomUUID } from "node:crypto";
/**
 * input 类型 UserAction submit 解析权威测试（真实 MySQL 8）。
 *
 * 冻结设计（authority payload）：
 * - request_type=input + resolution=submit 时，入队的 resume InvocationCommand 必须在
 *   commandPayloadJson.resume_payload 中持久化精确的脱敏响应对象（UI schema {text:string}），
 *   不能只写 has_response:true 布尔证据。
 * - 其他 request_type 保持既有语义；不发明 text。
 * - 缺失/非对象 responseRedactedJson 维持既有拒绝。
 *
 * 事实源：resolveGenericUserAction（S10-W05）+ 生产 Resume 网关（08 §5）。
 */
import { resolveGenericUserAction } from "@/lib/conversations/user-action-resolve-queries";
import { db } from "@/lib/db/client";
import { resetDatabase } from "@/lib/db/test/mysql-harness";
import { DEFAULT_TENANT_ID, ensureDefaultTenant } from "@/lib/identity/tenant-bootstrap";
import { UserActionValidationError } from "@/lib/permission/user-action-queries";
import { threadTable, turnTable } from "@/lib/persistence/schema/conversation";
import { invocationTable } from "@/lib/persistence/schema/executions";
import { userActionRequestTable } from "@/lib/persistence/schema/user-action-request";
import { eq } from "drizzle-orm";
import { beforeEach, describe, expect, it } from "vitest";

const TENANT = DEFAULT_TENANT_ID;

/** 最小 Thread 行（resolve 事务需要事件流 + 乐观锁基线）。 */
async function seedThread(id: string): Promise<void> {
  await db.insert(threadTable).values({
    id,
    tenantId: TENANT,
    ownerUserId: "user-1",
    defaultWorkspaceId: null,
    activeGoalId: null,
    title: null,
    defaultModelRef: null,
    defaultEnvironmentDefinitionId: null,
    lastActivityAt: new Date(),
    lastTurnSequence: 0,
    lastItemSequence: 0,
    lastEventSequence: 0,
    pendingQueueVersionNo: 1,
    versionNo: 1,
    createdAt: new Date(),
    updatedAt: new Date(),
    deletedAt: null,
  });
}

/** seed waiting_user 的 Turn + Invocation + pending input UserActionRequest。 */
async function seedWaitingInputRequest(): Promise<{
  requestId: string;
  invocationId: string;
  threadId: string;
  turnId: string;
}> {
  const threadId = randomUUID();
  await seedThread(threadId);

  const turnId = randomUUID();
  await db.insert(turnTable).values({
    id: turnId,
    threadId,
    turnSequence: 1,
    triggerType: "user_message",
    triggerRef: null,
    triggerItemId: null,
    turnState: "waiting_user",
    versionNo: 1,
  });

  const invocationId = randomUUID();
  await db.insert(invocationTable).values({
    id: invocationId,
    tenantId: TENANT,
    threadId,
    turnId,
    jobId: null,
    invocationSequence: 1,
    invocationKind: "initial",
    executionState: "waiting_user",
    triggerItemId: null,
    replacesInvocationId: null,
    outputItemId: null,
    resultRef: null,
    runtimeSessionBindingId: null,
    runtimeExecutionRef: null,
    startedAt: new Date(),
    finishedAt: null,
    lastHeartbeatAt: new Date(),
    errorCode: null,
    errorSummary: null,
    versionNo: 1,
    createdAt: new Date(),
    updatedAt: new Date(),
  });

  const requestId = randomUUID();
  await db.insert(userActionRequestTable).values({
    id: requestId,
    tenantId: TENANT,
    threadId,
    turnId,
    invocationId,
    toolCallId: null,
    itemId: null,
    requestType: "input",
    purpose: "a2a_input_required",
    requestState: "pending",
    promptJson: { kind: "user_action.requested", prompt: "请提供请假事由" },
    inputSchemaJson: {
      type: "object",
      additionalProperties: false,
      required: ["text"],
      properties: { text: { type: "string", minLength: 1, maxLength: 20_000 } },
    },
    expiresAt: null,
    versionNo: 1,
  });

  return { requestId, invocationId, threadId, turnId };
}

beforeEach(async () => {
  await resetDatabase(db);
  await ensureDefaultTenant();
});

describe("resolveGenericUserAction input submit（authority payload）", () => {
  it("submit：Invocation waiting_user→running + resume 命令持久化精确 resume_payload 对象", async () => {
    const seeded = await seedWaitingInputRequest();
    const response = { text: "年休假，明天一天" };

    const result = await resolveGenericUserAction({
      tenantId: TENANT,
      requestId: seeded.requestId,
      resolution: "submit",
      resolvedBy: "user-1",
      responseRedactedJson: response,
      actorType: "user",
      actorId: "user-1",
    });

    // 权威状态推进：waiting_user → running。
    expect(result.invocation.executionState).toBe("running");
    const [invRow] = await db
      .select()
      .from(invocationTable)
      .where(eq(invocationTable.id, seeded.invocationId))
      .limit(1);
    expect(invRow?.executionState).toBe("running");

    // 冻结断言：queued resume 命令必须携带精确 resume_payload 对象（非仅 has_response）
    // + 内部来源标记（post-authority Resume 凭证）。
    const payload = result.resumeCommand.commandPayloadJson as Record<string, unknown>;
    expect(payload.resume_payload).toEqual({ text: "年休假，明天一天" });
    expect(payload.resume_source).toBe("user_action_resolution");
    expect(payload.request_id).toBe(seeded.requestId);
    expect(result.resumeCommand.commandState).toBe("queued");
    expect(result.resumeCommand.commandType).toBe("resume");

    // request 已 resolved 且脱敏响应按原对象持久化。
    expect(result.request.requestState).toBe("resolved");
    expect(result.request.resolution).toBe("submit");
    expect(result.request.responseRedactedJson).toEqual({ text: "年休假，明天一天" });
  });

  it("submit 缺失 responseRedactedJson：维持既有拒绝", async () => {
    const seeded = await seedWaitingInputRequest();
    await expect(
      resolveGenericUserAction({
        tenantId: TENANT,
        requestId: seeded.requestId,
        resolution: "submit",
        resolvedBy: "user-1",
      }),
    ).rejects.toThrow(UserActionValidationError);
  });

  it("submit 非对象 responseRedactedJson（字符串）：维持既有拒绝", async () => {
    const seeded = await seedWaitingInputRequest();
    await expect(
      resolveGenericUserAction({
        tenantId: TENANT,
        requestId: seeded.requestId,
        resolution: "submit",
        resolvedBy: "user-1",
        responseRedactedJson: "年休假，明天一天",
      }),
    ).rejects.toThrow(UserActionValidationError);
  });
});
