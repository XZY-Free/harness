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
import {
  invocationCommandTable,
  threadEventTable,
  threadItemTable,
  threadTable,
  turnTable,
} from "@/lib/persistence/schema/conversation";
import { invocationTable } from "@/lib/persistence/schema/executions";
import { userActionRequestTable } from "@/lib/persistence/schema/user-action-request";
import { and, eq } from "drizzle-orm";
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
  const itemId = randomUUID();
  await db.insert(threadItemTable).values({
    id: itemId,
    threadId,
    turnId,
    invocationId,
    itemSequence: 1,
    itemType: "user_action",
    itemState: "pending",
    authorType: "assistant",
    contentJson: { request_id: requestId, request_type: "input", prompt: "请提供请假事由" },
    contentHash: "initial",
  });
  await db.insert(userActionRequestTable).values({
    id: requestId,
    tenantId: TENANT,
    threadId,
    turnId,
    invocationId,
    toolCallId: null,
    itemId,
    requestType: "input",
    purpose: "a2a_input_required",
    requestState: "pending",
    promptJson: { kind: "user_action.requested", prompt: "请提供请假事由" },
    inputSchemaJson: {
      type: "object",
      additionalProperties: false,
      required: ["text"],
      properties: {
        text: { type: "string", minLength: 1, maxLength: 20_000, pattern: "\\S" },
      },
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
  it("并发提交只消费一次，请求和卡片一致且只有一条恢复命令", async () => {
    const seeded = await seedWaitingInputRequest();
    const params = {
      tenantId: TENANT,
      requestId: seeded.requestId,
      resolution: "submit" as const,
      resolvedBy: "user-1",
      responseRedactedJson: { text: "明天一天" },
    };
    const results = await Promise.allSettled([
      resolveGenericUserAction(params),
      resolveGenericUserAction(params),
    ]);
    expect(results.filter((r) => r.status === "fulfilled")).toHaveLength(1);
    expect(results.filter((r) => r.status === "rejected")).toHaveLength(1);
    const commands = await db
      .select()
      .from(invocationCommandTable)
      .where(eq(invocationCommandTable.invocationId, seeded.invocationId));
    expect(commands).toHaveLength(1);
    const items = await db
      .select()
      .from(threadItemTable)
      .where(eq(threadItemTable.threadId, seeded.threadId));
    expect(items).toHaveLength(1);
    expect(items[0]!.itemState).toBe("completed");
  });

  it("卡片引用跨会话时回滚整个解析，不能修改另一会话卡片", async () => {
    const seeded = await seedWaitingInputRequest();
    const other = await seedWaitingInputRequest();
    const [otherItem] = await db
      .select()
      .from(threadItemTable)
      .where(eq(threadItemTable.threadId, other.threadId));
    await db
      .update(userActionRequestTable)
      .set({ itemId: null })
      .where(eq(userActionRequestTable.id, other.requestId));
    await db
      .update(userActionRequestTable)
      .set({ itemId: otherItem!.id })
      .where(eq(userActionRequestTable.id, seeded.requestId));
    await expect(
      resolveGenericUserAction({
        tenantId: TENANT,
        requestId: seeded.requestId,
        resolution: "submit",
        resolvedBy: "user-1",
        responseRedactedJson: { text: "明天一天" },
      }),
    ).rejects.toThrow("操作卡片与请求不匹配");
    const [request] = await db
      .select()
      .from(userActionRequestTable)
      .where(eq(userActionRequestTable.id, seeded.requestId));
    expect(request!.requestState).toBe("pending");
    expect(request!.resolution).toBeNull();
    const [invocation] = await db
      .select()
      .from(invocationTable)
      .where(eq(invocationTable.id, seeded.invocationId));
    expect(invocation!.executionState).toBe("waiting_user");
    const [item] = await db
      .select()
      .from(threadItemTable)
      .where(eq(threadItemTable.id, otherItem!.id));
    expect(item!.itemState).toBe("pending");
    expect(
      await db
        .select()
        .from(invocationCommandTable)
        .where(eq(invocationCommandTable.invocationId, seeded.invocationId)),
    ).toHaveLength(0);
    expect(
      await db
        .select()
        .from(threadEventTable)
        .where(eq(threadEventTable.threadId, seeded.threadId)),
    ).toHaveLength(0);
  });

  it("跨租户解析不可消费请求或卡片", async () => {
    const seeded = await seedWaitingInputRequest();
    await expect(
      resolveGenericUserAction({
        tenantId: randomUUID(),
        requestId: seeded.requestId,
        resolution: "submit",
        resolvedBy: "user-1",
        responseRedactedJson: { text: "明天一天" },
      }),
    ).rejects.toThrow("不存在或跨租户不可见");
    const [item] = await db
      .select()
      .from(threadItemTable)
      .where(eq(threadItemTable.threadId, seeded.threadId));
    expect(item!.itemState).toBe("pending");
  });

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
    const [turnRow] = await db
      .select()
      .from(turnTable)
      .where(eq(turnTable.id, seeded.turnId))
      .limit(1);
    expect(turnRow?.turnState).toBe("running");

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

    const [item] = await db
      .select()
      .from(threadItemTable)
      .where(eq(threadItemTable.id, result.request.itemId!));
    if (!item) throw new Error("请求卡片未持久化");
    expect(item.itemState).toBe("completed");
    expect(item.contentJson).toEqual({
      request_id: seeded.requestId,
      request_type: "input",
      prompt: "请提供请假事由",
      state: "resolved",
      resolution: "submit",
    });
    expect(item.contentHash).not.toBe("initial");
    expect(JSON.stringify(item.contentJson)).not.toContain(response.text);
    expect(result.events[0]!.itemId).toBe(item.id);
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

describe("resolveGenericUserAction input submit 按 inputSchemaJson 校验（RED 矩阵）", () => {
  /**
   * 断言非法 response 在事务开始前被拒绝，且事务完全未消费：
   * UAR 仍 pending、Invocation 仍 waiting_user、无 resume InvocationCommand、无 user_action.resolved 事件。
   * 若 resolver 不校验 schema，会先把 UAR/Invocation 消费掉，transport 之后才失败，用户无法重试。
   */
  async function expectRejectedWithoutConsumption(responseRedactedJson: unknown): Promise<void> {
    const seeded = await seedWaitingInputRequest();

    await expect(
      resolveGenericUserAction({
        tenantId: TENANT,
        requestId: seeded.requestId,
        resolution: "submit",
        resolvedBy: "user-1",
        responseRedactedJson,
        actorType: "user",
        actorId: "user-1",
      }),
    ).rejects.toThrow(UserActionValidationError);

    const [uarAfter] = await db
      .select()
      .from(userActionRequestTable)
      .where(eq(userActionRequestTable.id, seeded.requestId))
      .limit(1);
    expect(uarAfter?.requestState).toBe("pending");
    expect(uarAfter?.resolution).toBeNull();
    const [itemAfter] = await db
      .select()
      .from(threadItemTable)
      .where(eq(threadItemTable.id, uarAfter!.itemId!));
    if (!itemAfter) throw new Error("请求卡片丢失");
    expect(itemAfter.itemState).toBe("pending");
    expect(itemAfter.contentHash).toBe("initial");

    const [invAfter] = await db
      .select()
      .from(invocationTable)
      .where(eq(invocationTable.id, seeded.invocationId))
      .limit(1);
    expect(invAfter?.executionState).toBe("waiting_user");

    const commands = await db
      .select()
      .from(invocationCommandTable)
      .where(eq(invocationCommandTable.invocationId, seeded.invocationId));
    expect(commands).toHaveLength(0);

    const resolvedEvents = await db
      .select()
      .from(threadEventTable)
      .where(
        and(
          eq(threadEventTable.threadId, seeded.threadId),
          eq(threadEventTable.eventType, "user_action.resolved"),
        ),
      );
    expect(resolvedEvents).toHaveLength(0);
  }

  it("合法 {text} 仍通过（不弱化既有权威断言）", async () => {
    const seeded = await seedWaitingInputRequest();
    const result = await resolveGenericUserAction({
      tenantId: TENANT,
      requestId: seeded.requestId,
      resolution: "submit",
      resolvedBy: "user-1",
      responseRedactedJson: { text: "年休假，明天一天" },
      actorType: "user",
      actorId: "user-1",
    });
    expect(result.request.requestState).toBe("resolved");
    expect(result.resumeCommand.commandPayloadJson).toMatchObject({
      resume_source: "user_action_resolution",
      resume_payload: { text: "年休假，明天一天" },
    });
  });

  it("空对象 {} 违反 required:[text] → UserActionValidationError 且事务未消费", async () => {
    await expectRejectedWithoutConsumption({});
  });

  it('{text:""} 违反 minLength:1 → UserActionValidationError 且事务未消费', async () => {
    await expectRejectedWithoutConsumption({ text: "" });
  });

  it('{text:"   "} 纯空白违反 pattern:"\\\\S"（与 resume trim 语义一致）→ 拒绝且事务未消费', async () => {
    await expectRejectedWithoutConsumption({ text: "   " });
  });

  it("text 长度 20001 违反 maxLength:20000 → UserActionValidationError 且事务未消费", async () => {
    await expectRejectedWithoutConsumption({ text: "a".repeat(20_001) });
  });

  it('额外键 {text:"有效", extra:"x"} 违反 additionalProperties:false → 拒绝且事务未消费', async () => {
    await expectRejectedWithoutConsumption({ text: "有效", extra: "x" });
  });

  it("{text:1} 违反 type:string → UserActionValidationError 且事务未消费", async () => {
    await expectRejectedWithoutConsumption({ text: 1 });
  });
});
