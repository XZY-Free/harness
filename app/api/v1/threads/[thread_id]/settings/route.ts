import {
  type Principal,
  THREAD_SETTINGS_ETAG_PREFIX,
  conversationErrorToResponse,
  employeeAuthErrorResponse,
  parseThreadSettingsEtag,
  resolveEmployeePrincipal,
  schemaInvalidTable,
} from "@/lib/conversations/route-helpers";
/**
 * PATCH /api/v1/threads/{thread_id}/settings — 更新 Thread 默认设置（S04-C03，§3.2）。
 *
 * 事实源：../v11-agentkit-platform/11-api-and-event-boundaries.md §3.2、
 *         ../v11-agentkit-platform-development-plan/04-thread-turn-item-and-event-core.md S04-W01。
 *
 * 行为：
 * - 解析员工身份 + 校验 Thread 属于当前员工（非 owner → 404 隐藏式）。
 * - 解析 If-Match ETag（必填）→ versionNo（乐观锁）。
 * - 调用 updateThreadSettingsWithEvents 事务内更新设置 + 写对应 Event。
 * - 返回 200 + 新 ETag + event_ids（实际写入的事件 id 列表）。
 *
 * 错误映射：
 * - Thread 不存在/非 owner/跨租户 → 404 RESOURCE_NOT_FOUND
 * - 缺少 If-Match → 400 REQUEST_SCHEMA_INVALID
 * - ETag 格式非法 → 400 REQUEST_SCHEMA_INVALID
 * - 乐观锁冲突 → 412 ETAG_MISMATCH
 */
import { getThreadById } from "@/lib/conversations/thread-queries";
import { updateThreadSettingsWithEvents } from "@/lib/conversations/thread-settings-queries";
import {
  ETAG_HEADER,
  REQUEST_ID_HEADER,
  apiSuccess,
  etagHeader,
  getRequestId,
  parseIfMatch,
  resourceNotFound,
} from "@/lib/http";

export const dynamic = "force-dynamic";

/** 路径参数上下文。 */
interface RouteContext {
  params: Promise<{ thread_id: string }>;
}

/** 请求体 schema（§3.2 requestBody：所有字段可选，至少一个）。 */
interface UpdateSettingsBody {
  default_model_ref?: string | null;
  default_workspace_id?: string | null;
  default_environment_definition_id?: string | null;
}

/** 校验请求体：每个字段为 string 或 null；至少一个字段存在。 */
function validateBody(body: unknown): body is UpdateSettingsBody {
  if (!body || typeof body !== "object") return false;
  const b = body as Record<string, unknown>;
  const allowedKeys = [
    "default_model_ref",
    "default_workspace_id",
    "default_environment_definition_id",
  ];
  // 至少一个字段存在
  const presentKeys = allowedKeys.filter((k) => b[k] !== undefined);
  if (presentKeys.length === 0) return false;
  // 每个存在字段必须是 string 或 null
  for (const k of presentKeys) {
    const v = b[k];
    if (v !== null && typeof v !== "string") return false;
  }
  return true;
}

export async function PATCH(request: Request, context: RouteContext): Promise<Response> {
  const requestId = getRequestId(request);
  const { thread_id: threadId } = await context.params;

  // 1. 解析员工身份
  let principal: Principal;
  try {
    principal = await resolveEmployeePrincipal(request.headers);
  } catch (err) {
    const authResp = employeeAuthErrorResponse(err, requestId);
    if (authResp) return authResp;
    throw err;
  }

  // 2. 校验 Thread 属于当前员工（非 owner → 404 隐藏式）
  const thread = await getThreadById(principal.tenantId, threadId);
  if (!thread || thread.ownerUserId !== principal.userIdentityId) {
    return resourceNotFound(requestId, `Thread 不存在或无权访问: ${threadId}`);
  }

  // 3. 解析 If-Match（必填）
  const ifMatchRaw = parseIfMatch(request);
  if (!ifMatchRaw) {
    return schemaInvalidTable(requestId, "缺少必填头 If-Match");
  }

  let expectedVersionNo: number;
  try {
    expectedVersionNo = parseThreadSettingsEtag(ifMatchRaw);
  } catch {
    return schemaInvalidTable(requestId, `If-Match ETag 格式非法: ${ifMatchRaw}`);
  }

  // 4. 解析请求体
  const body = await request.json().catch(() => null);
  if (!validateBody(body)) {
    return schemaInvalidTable(
      requestId,
      "请求体非法：至少一个字段（default_model_ref/default_workspace_id/default_environment_definition_id），值类型为 string 或 null",
    );
  }

  // 5. 执行业务：事务内更新设置 + 写对应 Event
  try {
    const { thread: updatedThread, events } = await updateThreadSettingsWithEvents({
      tenantId: principal.tenantId,
      threadId,
      expectedVersionNo,
      updates: {
        defaultModelRef: body.default_model_ref,
        defaultWorkspaceId: body.default_workspace_id,
        defaultEnvironmentDefinitionId: body.default_environment_definition_id,
      },
      actorType: "user",
      actorId: principal.userIdentityId,
    });

    // 6. 返回 200 + 新 ETag + event_ids
    const responseBody = {
      thread_id: updatedThread.id,
      default_model_ref: updatedThread.defaultModelRef,
      default_workspace_id: updatedThread.defaultWorkspaceId,
      default_environment_definition_id: updatedThread.defaultEnvironmentDefinitionId,
      applies_to_new_invocations: true,
      event_ids: events.map((e) => e.id),
      etag: `${THREAD_SETTINGS_ETAG_PREFIX}${updatedThread.versionNo}`,
    };

    return apiSuccess(responseBody, {
      status: 200,
      headers: {
        [REQUEST_ID_HEADER]: requestId,
        ...etagHeader(`${THREAD_SETTINGS_ETAG_PREFIX}${updatedThread.versionNo}`),
        [ETAG_HEADER]: `"${THREAD_SETTINGS_ETAG_PREFIX}${updatedThread.versionNo}"`,
      },
    });
  } catch (err) {
    const errorResp = conversationErrorToResponse(err, requestId);
    if (errorResp) return errorResp;
    throw err;
  }
}
