import {
  type Principal,
  employeeAuthErrorResponse,
  resolveEmployeePrincipal,
  schemaInvalidTable,
} from "@/lib/conversations/route-helpers";
/**
 * GET/PATCH/DELETE /api/v1/memory-entries/{entry_id} — 用户控制 MemoryEntry（阶段 7 S07-C04）。
 *
 * 事实源：
 * - ../v11-agentkit-platform/03-context-memory-and-knowledge.md §11（禁止内容与用户控制）。
 * - ../v11-agentkit-platform/11-api-and-event-boundaries.md §3（Employee API）。
 *
 * 行为：
 * - GET：查询单个 MemoryEntry（跨租户隔离）。
 * - PATCH：修改 MemoryEntry 内容和/或过期时间（用户明确设置优先于自动提取）。
 * - DELETE：归档 MemoryEntry（memoryState: active → archived，不物理删除）。
 *
 * 错误映射：
 * - 缺少身份 → 401 AUTHENTICATION_REQUIRED
 * - Entry 不存在/跨租户 → 404 RESOURCE_NOT_FOUND
 * - 请求体非法 → 400 REQUEST_SCHEMA_INVALID
 *
 * 边界：
 * - 用户只能操作自己租户的 MemoryEntry（跨租户隔离）。
 * - restricted sensitivity 的 Entry 不回显正文。
 * - DELETE 不物理删除，归档后不再参与检索。
 */
import { REQUEST_ID_HEADER, apiSuccess, getRequestId, resourceNotFound } from "@/lib/http";
import {
  archiveMemoryEntry,
  getMemoryEntryById,
  updateMemoryEntry,
} from "@/lib/v11/context/memory-queries";

export const dynamic = "force-dynamic";

/** 从 URL 路径提取 entry_id。 */
function extractEntryId(url: string): string | null {
  const match = url.match(/\/api\/v1\/memory-entries\/([^/?#]+)/);
  const id = match?.[1];
  return id ? decodeURIComponent(id) : null;
}

/** 把 MemoryEntry 行投影为 API 响应体（snake_case；restricted 不回显正文）。 */
function projectEntry(entry: {
  id: string;
  scopeType: string;
  scopeRef: string | null;
  memoryType: string;
  contentRef: string | null;
  contentRedacted: string | null;
  contentHash: string;
  sensitivityClass: string;
  memoryState: string;
  validFrom: Date;
  expiresAt: Date | null;
  createdAt: Date;
  updatedAt: Date;
}): {
  entry_id: string;
  scope: { type: string; ref: string | null };
  memory_type: string;
  content_ref: string | null;
  content_redacted: string | null;
  content_hash: string;
  sensitivity_class: string;
  memory_state: string;
  valid_from: string;
  expires_at: string | null;
  created_at: string;
  updated_at: string;
} {
  return {
    entry_id: entry.id,
    scope: { type: entry.scopeType, ref: entry.scopeRef },
    memory_type: entry.memoryType,
    content_ref: entry.contentRef,
    content_redacted: entry.sensitivityClass === "restricted" ? null : entry.contentRedacted,
    content_hash: entry.contentHash,
    sensitivity_class: entry.sensitivityClass,
    memory_state: entry.memoryState,
    valid_from: entry.validFrom.toISOString(),
    expires_at: entry.expiresAt ? entry.expiresAt.toISOString() : null,
    created_at: entry.createdAt.toISOString(),
    updated_at: entry.updatedAt.toISOString(),
  };
}

/** GET /api/v1/memory-entries/{entry_id} handler。 */
export async function GET(request: Request): Promise<Response> {
  const requestId = getRequestId(request);

  let principal: Principal;
  try {
    principal = await resolveEmployeePrincipal(request.headers);
  } catch (error) {
    const authResponse = employeeAuthErrorResponse(error, requestId);
    return authResponse ?? schemaInvalidTable(requestId, "身份解析失败");
  }

  const entryId = extractEntryId(request.url);
  if (!entryId) {
    return resourceNotFound(requestId, "entry_id 缺失");
  }

  const entry = await getMemoryEntryById(principal.tenantId, entryId);
  if (!entry) {
    return resourceNotFound(requestId, "MemoryEntry 不存在或无权访问");
  }

  return apiSuccess(projectEntry(entry), {
    status: 200,
    headers: { [REQUEST_ID_HEADER]: requestId },
  });
}

/** PATCH /api/v1/memory-entries/{entry_id} handler。 */
export async function PATCH(request: Request): Promise<Response> {
  const requestId = getRequestId(request);

  let principal: Principal;
  try {
    principal = await resolveEmployeePrincipal(request.headers);
  } catch (error) {
    const authResponse = employeeAuthErrorResponse(error, requestId);
    return authResponse ?? schemaInvalidTable(requestId, "身份解析失败");
  }

  const entryId = extractEntryId(request.url);
  if (!entryId) {
    return resourceNotFound(requestId, "entry_id 缺失");
  }

  const body = await request.json().catch(() => null);
  if (!body || typeof body !== "object") {
    return schemaInvalidTable(requestId, "请求体必须是 JSON 对象");
  }
  const b = body as Record<string, unknown>;

  const updates: { contentRedacted?: string; contentRef?: string; expiresAt?: Date | null } = {};

  if (b.content_redacted !== undefined) {
    if (typeof b.content_redacted !== "string" || b.content_redacted.length === 0) {
      return schemaInvalidTable(requestId, "content_redacted 必须是非空字符串");
    }
    if (b.content_redacted.length > 100_000) {
      return schemaInvalidTable(requestId, "content_redacted 超过最大长度 100000");
    }
    updates.contentRedacted = b.content_redacted;
  }

  if (b.content_ref !== undefined && b.content_ref !== null) {
    if (typeof b.content_ref !== "string" || b.content_ref.length === 0) {
      return schemaInvalidTable(requestId, "content_ref 必须是非空字符串");
    }
    if (b.content_ref.length > 512) {
      return schemaInvalidTable(requestId, "content_ref 超过最大长度 512");
    }
    updates.contentRef = b.content_ref;
  }

  if (b.expires_at !== undefined && b.expires_at !== null) {
    if (typeof b.expires_at !== "string") {
      return schemaInvalidTable(requestId, "expires_at 必须是 ISO 8601 字符串");
    }
    const expiresAt = new Date(b.expires_at);
    if (Number.isNaN(expiresAt.getTime())) {
      return schemaInvalidTable(requestId, "expires_at 必须是有效的 ISO 8601 日期");
    }
    updates.expiresAt = expiresAt;
  } else if (b.expires_at === null) {
    updates.expiresAt = null;
  }

  // 校验 Entry 存在
  const existing = await getMemoryEntryById(principal.tenantId, entryId);
  if (!existing) {
    return resourceNotFound(requestId, "MemoryEntry 不存在或无权访问");
  }

  const updated = await updateMemoryEntry(principal.tenantId, entryId, updates);
  if (!updated) {
    return resourceNotFound(requestId, "MemoryEntry 不存在或无权访问");
  }

  return apiSuccess(projectEntry(updated), {
    status: 200,
    headers: { [REQUEST_ID_HEADER]: requestId },
  });
}

/** DELETE /api/v1/memory-entries/{entry_id} handler（归档，不物理删除）。 */
export async function DELETE(request: Request): Promise<Response> {
  const requestId = getRequestId(request);

  let principal: Principal;
  try {
    principal = await resolveEmployeePrincipal(request.headers);
  } catch (error) {
    const authResponse = employeeAuthErrorResponse(error, requestId);
    return authResponse ?? schemaInvalidTable(requestId, "身份解析失败");
  }

  const entryId = extractEntryId(request.url);
  if (!entryId) {
    return resourceNotFound(requestId, "entry_id 缺失");
  }

  // 校验 Entry 存在
  const existing = await getMemoryEntryById(principal.tenantId, entryId);
  if (!existing) {
    return resourceNotFound(requestId, "MemoryEntry 不存在或无权访问");
  }

  const archived = await archiveMemoryEntry(principal.tenantId, entryId);
  if (!archived) {
    return resourceNotFound(requestId, "MemoryEntry 不存在或无权访问");
  }

  return apiSuccess(projectEntry(archived), {
    status: 200,
    headers: { [REQUEST_ID_HEADER]: requestId },
  });
}
