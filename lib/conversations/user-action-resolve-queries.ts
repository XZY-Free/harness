/**
 * 通用 UserAction 解析应用服务（S10-W05）。
 *
 * 事实源：
 * - docs/architecture/api-and-events.md （解析 UserActionRequest）、
 * （auth callback）、（user_action.resolved Event）
 * - docs/architecture/persistence.md （user_action_request 表）、
 * - docs/architecture/capability-and-collaboration-api.md §5（Handoff 统一规则）
 * - docs/architecture/product-surfaces-and-admin.md S10-W05
 *
 * 职责：
 * - resolveGenericUserAction：员工解析非 handoff 的 UserAction 请求（confirmation 非 handoff / grant / input / auth cancel）。
 * 事务内：SELECT FOR UPDATE UserActionRequest + 校验 + 原子 UPDATE pending → resolved +
 * UPDATE Invocation waiting_user → running + 写 user_action.resolved Event + 入队 resume InvocationCommand。
 * grant 类型 approve 时同事务创建 Grant 并回填 grant_id。
 * input 类型 submit 时写入 responseRedactedJson。
 *
 * 关键约束（/ / §5）：
 * - 不处理 auth + approve（auth approve 只能由 completeAuthCallback 写入；:resolve 接口仅接受 cancel）。
 * - 同一 UserActionRequest 只能解析一次：原子 UPDATE WHERE requestState='pending'，受影响行数=0 → 抛 UserActionAlreadyResolvedError。
 * - resolution 必须在 ALLOWED_RESOLUTIONS_BY_TYPE 内；否则抛 UserActionResolutionMismatchError。
 * - 当前 Invocation 必须 waiting_user（其他状态抛 UserActionStateError）。
 * - 不创建 ThreadRelation；不创建新 Thread。
 * - 仅 1 个 Event（user_action.resolved）。
 * - grant 类型 approve 时由本函数创建 Grant。
 * - input 类型 submit 时由本函数写入 responseRedactedJson。
 */
import { randomUUID } from "node:crypto";
import { updateToolCallState } from "@/lib/capability/tool-call-queries";
import { ThreadNotFoundError } from "@/lib/conversations/errors";
import {
  allocateEventSequences,
  computeEventPayloadHash,
  insertThreadEvent,
} from "@/lib/conversations/thread-queries";
import { db } from "@/lib/db/client";
import { issueGrant } from "@/lib/permission/permission-queries";
import {
  TOOL_PERMISSION_CONFIRMATION_PURPOSE,
  UserActionAlreadyResolvedError,
  UserActionNotFoundError,
  UserActionResolutionMismatchError,
  UserActionStateError,
  UserActionValidationError,
} from "@/lib/permission/user-action-queries";
import {
  type InvocationCommand,
  type Thread,
  type ThreadEvent,
  type ThreadEventActorType,
  invocationCommandTable,
  threadItemTable,
  threadTable,
} from "@/lib/persistence/schema/conversation";
import { type Invocation, invocationTable } from "@/lib/persistence/schema/executions";
import {
  ALLOWED_RESOLUTIONS_BY_TYPE,
  type UserActionRequest,
  type UserActionResolution,
  userActionRequestTable,
} from "@/lib/persistence/schema/user-action-request";
import { updateInvocationState } from "@/lib/runtime/invocation-queries";
import Ajv, { type ValidateFunction } from "ajv";
import { and, eq } from "drizzle-orm";

/**
 * input+submit：按 UAR.inputSchemaJson 真实 JSON Schema 校验响应（required/type/
 * minLength/maxLength/pattern/additionalProperties 等）。
 * fail-closed：schema 缺失/非法/无法编译一律拒绝；错误信息为固定文案，
 * 不包含用户响应原文、secret 或 Ajv 内部细节。
 */
function validateInputResponseAgainstSchema(schemaJson: unknown, response: object): void {
  if (!schemaJson || typeof schemaJson !== "object" || Array.isArray(schemaJson)) {
    throw new UserActionValidationError(
      "input 类型 submit 缺少合法的 input_schema，无法校验响应（fail-closed 拒绝）",
    );
  }
  let ajv: Ajv;
  try {
    ajv = new Ajv({ strict: false, allErrors: true });
  } catch {
    throw new UserActionValidationError(
      "input 类型 submit 的 input_schema 校验器初始化失败（fail-closed 拒绝）",
    );
  }
  let validate: ValidateFunction;
  try {
    validate = ajv.compile(schemaJson);
  } catch {
    throw new UserActionValidationError(
      "input 类型 submit 的 input_schema 非法，无法校验响应（fail-closed 拒绝）",
    );
  }
  if (!validate(response)) {
    throw new UserActionValidationError(
      "input 类型 submit 响应不符合请求 input_schema 约束（required/type/minLength/maxLength/pattern/additionalProperties）",
    );
  }
}

/** resolveGenericUserAction 入参。 */
export interface ResolveGenericUserActionParams {
  readonly tenantId: string;
  /** UserActionRequest id（必须 purpose != handoff；state=pending；非 auth+approve）。 */
  readonly requestId: string;
  /** resolution：approve / deny / submit / cancel（按 request_type 允许集合校验）。 */
  readonly resolution: UserActionResolution;
  /** 解析人 userId（员工身份）。 */
  readonly resolvedBy: string;
  /** input 类型 submit 时必填：已脱敏的响应 JSON。 */
  readonly responseRedactedJson?: unknown | null;
  /** 触发事件的 actor 类型（默认 user）。 */
  readonly actorType?: ThreadEventActorType;
  readonly actorId?: string;
  readonly idempotencyKey?: string;
  readonly correlationId?: string;
}

/** resolveGenericUserAction 返回结果。 */
export interface ResolveGenericUserActionResult {
  /** 更新后的 UserActionRequest（requestState=resolved, resolution=传入值）。 */
  readonly request: UserActionRequest;
  /** 写入的 ThreadEvent（按 sequence 升序）：1 条 user_action.resolved。 */
  readonly events: ThreadEvent[];
  /** 更新后的 Thread（仅 lastActivityAt + versionNo 递增）。 */
  readonly thread: Thread;
  /** 更新后的 Invocation（executionState=running，由 waiting_user 恢复）。 */
  readonly invocation: Invocation;
  /** 入队的 resume InvocationCommand（让 Runtime 继续执行）。 */
  readonly resumeCommand: InvocationCommand;
  /** grant 类型 approve 时返回新建的 Grant id；其他场景为 undefined。 */
  readonly grantId?: string;
}

/**
 * 解析非 handoff 的 UserAction 请求（员工 :resolve 接口入口）。
 *
 * 流程（同事务）：
 * 1. SELECT FOR UPDATE UserActionRequest（校验 pending + purpose != handoff + request_type/resolution 兼容）
 * 2. 校验非 auth + approve（auth approve 由 callback 写入）
 * 3. SELECT FOR UPDATE Thread（锁定事件流）
 * 4. SELECT FOR UPDATE Invocation（必须 waiting_user）
 * 5. 原子 UPDATE UserActionRequest: pending → resolved（resolution, resolvedBy, resolvedAt）
 * 6. grant + approve 时创建 Grant + 回填 grant_id
 * 7. UPDATE Invocation: waiting_user → running
 * 8. UPDATE Thread: lastActivityAt + versionNo 递增
 * 9. allocateEventSequences(1) → 写入 user_action.resolved Event
 * 10. INSERT InvocationCommand（commandType=resume，让 Runtime 恢复执行）
 *
 * @throws UserActionNotFoundError UserActionRequest 不存在或跨租户不可见
 * @throws UserActionValidationError 请求参数非法（tenantId/requestId/resolvedBy 为空）
 * @throws UserActionResolutionMismatchError resolution 与 request_type 不匹配
 * @throws UserActionAlreadyResolvedError 请求已解析或过期
 * @throws UserActionStateError Invocation 非 waiting_user 状态
 * @throws ThreadNotFoundError Thread 不存在或跨租户不可见
 */
export async function resolveGenericUserAction(
  params: ResolveGenericUserActionParams,
): Promise<ResolveGenericUserActionResult> {
  if (!params.tenantId) {
    throw new UserActionValidationError("tenantId 不能为空");
  }
  if (!params.requestId) {
    throw new UserActionValidationError("requestId 不能为空");
  }
  if (!params.resolvedBy) {
    throw new UserActionValidationError("resolvedBy 不能为空");
  }

  const actorType: ThreadEventActorType = params.actorType ?? "user";
  const now = new Date();

  const result = await db.transaction(async (tx) => {
    // 1. SELECT FOR UPDATE UserActionRequest
    const [request] = await tx
      .select()
      .from(userActionRequestTable)
      .where(
        and(
          eq(userActionRequestTable.tenantId, params.tenantId),
          eq(userActionRequestTable.id, params.requestId),
        ),
      )
      .for("update")
      .limit(1);
    if (!request) {
      throw new UserActionNotFoundError(
        `UserActionRequest 不存在或跨租户不可见: ${params.requestId}`,
      );
    }

    // 校验 pending 状态
    if (request.requestState !== "pending") {
      throw new UserActionAlreadyResolvedError(request.id, request.requestState);
    }

    // 过期检查
    if (request.expiresAt && request.expiresAt.getTime() <= Date.now()) {
      throw new UserActionAlreadyResolvedError(request.id, "expired");
    }

    // 校验 resolution 与 request_type 兼容
    if (!ALLOWED_RESOLUTIONS_BY_TYPE[request.requestType].includes(params.resolution)) {
      throw new UserActionResolutionMismatchError(request.requestType, params.resolution);
    }

    // 校验非 auth + approve（auth approve 由 completeAuthCallback 写入）
    if (request.requestType === "auth" && params.resolution === "approve") {
      throw new UserActionValidationError(
        "auth 类型 approve 只能由可信 callback 写入；:resolve 接口仅接受 cancel",
      );
    }

    // input + submit 必须提供 responseRedactedJson，且在锁定 pending UAR 后、
    // 任何 UPDATE/事件/命令写入前，按 inputSchemaJson 真实校验（Ajv）。
    if (request.requestType === "input" && params.resolution === "submit") {
      if (!params.responseRedactedJson || typeof params.responseRedactedJson !== "object") {
        throw new UserActionValidationError(
          "input 类型 submit 必须提供 responseRedactedJson（对象）",
        );
      }
      validateInputResponseAgainstSchema(request.inputSchemaJson, params.responseRedactedJson);
    }

    // 2. SELECT FOR UPDATE Thread（锁定事件流 + 乐观锁基线）
    const [thread] = await tx
      .select()
      .from(threadTable)
      .where(and(eq(threadTable.tenantId, params.tenantId), eq(threadTable.id, request.threadId)))
      .for("update")
      .limit(1);
    if (!thread) {
      throw new ThreadNotFoundError(request.threadId);
    }

    // 3. SELECT FOR UPDATE Invocation（必须 waiting_user）
    const [invocation] = await tx
      .select()
      .from(invocationTable)
      .where(
        and(
          eq(invocationTable.tenantId, params.tenantId),
          eq(invocationTable.id, request.invocationId),
        ),
      )
      .for("update")
      .limit(1);
    if (!invocation) {
      throw new UserActionStateError(`Invocation ${request.invocationId} 不存在或跨租户不可见`);
    }
    if (invocation.executionState !== "waiting_user") {
      throw new UserActionStateError(
        `Invocation ${request.invocationId} executionState=${invocation.executionState}，仅 waiting_user 可 resolve`,
      );
    }

    // 4. 原子 UPDATE UserActionRequest: pending → resolved
    const updateResult = await tx
      .update(userActionRequestTable)
      .set({
        requestState: "resolved",
        resolution: params.resolution,
        resolvedBy: params.resolvedBy,
        resolvedAt: now,
        responseRedactedJson: params.responseRedactedJson ?? null,
        versionNo: request.versionNo + 1,
        updatedAt: now,
      })
      .where(
        and(
          eq(userActionRequestTable.id, request.id),
          eq(userActionRequestTable.tenantId, params.tenantId),
          eq(userActionRequestTable.requestState, "pending"),
          eq(userActionRequestTable.versionNo, request.versionNo),
        ),
      );
    if ((updateResult[0]?.affectedRows ?? 0) === 0) {
      const [after] = await tx
        .select()
        .from(userActionRequestTable)
        .where(eq(userActionRequestTable.id, request.id))
        .limit(1);
      throw new UserActionAlreadyResolvedError(
        request.id,
        after?.requestState ?? request.requestState,
      );
    }

    // 5. grant + approve 时创建 Grant + 回填 grant_id
    let grantId: string | undefined;
    if (request.requestType === "grant" && params.resolution === "approve") {
      // 从 promptJson 提取 grant 参数（由请求发起方写入）
      const prompt = request.promptJson as {
        user_id?: string;
        scope?: readonly string[];
        credential_ref_id?: string;
        grant_expires_at?: string;
      };
      const grantUserId = prompt.user_id ?? params.resolvedBy;
      const grantScope = prompt.scope;
      const grantCredentialRefId = prompt.credential_ref_id;
      if (!grantScope || !Array.isArray(grantScope) || grantScope.length === 0) {
        throw new UserActionValidationError(
          "grant 类型 approve 时 promptJson.scope 必须是非空数组",
        );
      }
      if (!grantCredentialRefId) {
        throw new UserActionValidationError(
          "grant 类型 approve 时 promptJson.credential_ref_id 必填",
        );
      }
      const grantExpiresAt = prompt.grant_expires_at ? new Date(prompt.grant_expires_at) : null;
      if (grantExpiresAt && grantExpiresAt.getTime() <= Date.now()) {
        throw new UserActionValidationError(
          "grant 类型 promptJson.grant_expires_at 必须是未来时间",
        );
      }
      const grant = await issueGrant(
        {
          tenantId: params.tenantId,
          userId: grantUserId,
          grantType: "user_consent",
          scope: [...grantScope],
          credentialRefId: grantCredentialRefId,
          issuedBy: params.resolvedBy,
          expiresAt: grantExpiresAt,
        },
        { tx }, // §22.1：与 UAR 解析同事务，禁止 issueGrant 回落到全局 db。
      );
      grantId = grant.id;
      await tx
        .update(userActionRequestTable)
        .set({ grantId, updatedAt: now })
        .where(eq(userActionRequestTable.id, request.id));
    }

    // §20.3 deny：Policy pause 的 tool_permission_confirmation 被员工 deny →
    // ToolCall paused → cancelled，errorCode=USER_DENIED。不生成 Grant
    // （requestType=confirmation 本就不走 grant 分支）。与 UAR 解析同事务。
    if (request.purpose === TOOL_PERMISSION_CONFIRMATION_PURPOSE && params.resolution === "deny") {
      if (!request.toolCallId) {
        throw new UserActionValidationError(
          "tool_permission_confirmation deny 必须关联 ToolCallId",
        );
      }
      await updateToolCallState(
        {
          tenantId: params.tenantId,
          toolCallId: request.toolCallId,
          toState: "cancelled",
          errorCode: "USER_DENIED",
        },
        tx,
      );
    }

    // 请求与可见卡片同事务推进；不把用户填写内容复制进公开时间线。
    if (request.itemId) {
      const [item] = await tx
        .select()
        .from(threadItemTable)
        .where(
          and(
            eq(threadItemTable.id, request.itemId),
            eq(threadItemTable.threadId, request.threadId),
            eq(threadItemTable.turnId, request.turnId),
            eq(threadItemTable.invocationId, request.invocationId),
            eq(threadItemTable.itemType, "user_action"),
          ),
        )
        .for("update")
        .limit(1);
      if (!item) throw new UserActionStateError("操作卡片与请求不匹配");
      const content = {
        ...(item.contentJson as Record<string, unknown>),
        state: "resolved",
        resolution: params.resolution,
      };
      await tx
        .update(threadItemTable)
        .set({
          itemState: "completed",
          contentJson: content,
          contentHash: computeEventPayloadHash(content),
          updatedAt: now,
        })
        .where(eq(threadItemTable.id, item.id));
    }

    // 6. UPDATE Invocation: waiting_user → running
    const updatedInvocation = await updateInvocationState(
      tx,
      params.tenantId,
      invocation.id,
      "running",
    );

    // 7. UPDATE Thread: lastActivityAt + versionNo 递增
    await tx
      .update(threadTable)
      .set({
        lastActivityAt: now,
        versionNo: thread.versionNo + 1,
        updatedAt: now,
      })
      .where(eq(threadTable.id, thread.id));

    // 8. allocateEventSequences(1) → 写入 user_action.resolved Event
    const startSeq = await allocateEventSequences(tx, thread.id, 1);
    const userActionResolvedEvent = await insertThreadEvent(tx, thread.id, startSeq, {
      eventType: "user_action.resolved",
      turnId: request.turnId,
      itemId: request.itemId ?? undefined,
      invocationId: request.invocationId,
      actorType,
      actorId: params.actorId ?? params.resolvedBy,
      payload: {
        request_id: request.id,
        request_type: request.requestType,
        purpose: request.purpose,
        resolution: params.resolution,
        resolved_by: params.resolvedBy,
        ...(grantId ? { grant_id: grantId } : {}),
        ...(params.responseRedactedJson ? { has_response: true } : {}),
      },
      idempotencyKey: params.idempotencyKey
        ? `${params.idempotencyKey}:user-action-resolved`
        : undefined,
      correlationId: params.correlationId,
    });
    const events: ThreadEvent[] = [userActionResolvedEvent];

    // 9. INSERT InvocationCommand (resume)
    const resumeCommandId = randomUUID();
    const resumePayload = {
      request_id: request.id,
      request_type: request.requestType,
      purpose: request.purpose,
      resolution: params.resolution,
      resumed_by: params.resolvedBy,
      ...(grantId ? { grant_id: grantId } : {}),
      ...(params.responseRedactedJson ? { has_response: true } : {}),
      // input+submit：精确脱敏响应对象 + 内部来源标记（post-authority Resume 凭证，
      // 其他类型不发明 resume_payload）。
      ...(request.requestType === "input" && params.resolution === "submit"
        ? {
            resume_source: "user_action_resolution",
            resume_payload: params.responseRedactedJson,
          }
        : {}),
    };
    const resumePayloadHash = computeEventPayloadHash(resumePayload);
    await tx.insert(invocationCommandTable).values({
      id: resumeCommandId,
      invocationId: invocation.id,
      threadId: thread.id,
      turnId: request.turnId,
      commandType: "resume",
      commandPayloadJson: resumePayload,
      commandPayloadHash: resumePayloadHash,
      commandState: "queued",
      runtimeExecutionRef: null,
      idempotencyKey: params.idempotencyKey ?? null,
      errorCode: null,
      errorMessage: null,
      dispatchedAt: null,
      acknowledgedAt: null,
      failedAt: null,
    });

    // 10. 回读 Thread / UserActionRequest / InvocationCommand
    const [refreshedThread] = await tx
      .select()
      .from(threadTable)
      .where(eq(threadTable.id, thread.id))
      .limit(1);
    if (!refreshedThread) {
      throw new Error(`resolveGenericUserAction: Thread 行未找到（id=${thread.id}）`);
    }

    const [refreshedRequest] = await tx
      .select()
      .from(userActionRequestTable)
      .where(eq(userActionRequestTable.id, request.id))
      .limit(1);
    if (!refreshedRequest) {
      throw new Error(`resolveGenericUserAction: UserActionRequest 行未找到（id=${request.id}）`);
    }

    const [resumeCommand] = await tx
      .select()
      .from(invocationCommandTable)
      .where(eq(invocationCommandTable.id, resumeCommandId))
      .limit(1);
    if (!resumeCommand) {
      throw new Error(
        `resolveGenericUserAction: InvocationCommand 行未找到（id=${resumeCommandId}）`,
      );
    }

    return {
      request: refreshedRequest,
      events,
      thread: refreshedThread,
      invocation: updatedInvocation,
      resumeCommand,
      ...(grantId ? { grantId } : {}),
    };
  });

  return result;
}
