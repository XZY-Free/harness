import {
  type Principal,
  employeeAuthErrorResponse,
  resolveEmployeePrincipal,
  schemaInvalidTable,
} from "@/lib/conversations/route-helpers";
/**
 * GET /api/v1/memory-entries — 列出当前用户可见的 MemoryEntry（阶段 7 S07-C04）。
 *
 * 事实源：
 * - docs/architecture/context-memory-and-knowledge.md §8（作用域）、§11（用户控制）。
 * - docs/architecture/api-and-events.md §3（Employee API）。
 *
 * 行为：
 * - 解析员工身份（employee audience）。
 * - 按 scope_type + scope_ref 过滤（query 参数，可选）。
 * - 默认只返回 active 状态；include_archived=true 返回含 archived。
 * - 返回 200 + MemoryEntry 投影列表。
 *
 * 错误映射：
 * - 缺少身份 → 401 AUTHENTICATION_REQUIRED
 * - 非法 scope_type → 400 REQUEST_SCHEMA_INVALID
 *
 * 边界：
 * - 用户只能查看自己租户的 MemoryEntry（跨租户隔离）。
 * - restricted sensitivity 的 Entry 不回显正文。
 */
import { REQUEST_ID_HEADER, apiSuccess, getRequestId } from "@/lib/http";
import {
  MEMORY_SCOPE_TYPES,
  type MemoryEntry,
  type MemoryScopeType,
} from "@/lib/persistence/schema/memory";
import { listMemoryEntriesByScope } from "@/lib/context/memory-queries";

export const dynamic = "force-dynamic";

const VALID_SCOPE_TYPES: ReadonlySet<string> = new Set(MEMORY_SCOPE_TYPES);

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
    // restricted sensitivity 不回显正文
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

export async function GET(request: Request): Promise<Response> {
  const requestId = getRequestId(request);

  // 1. 解析员工身份
  let principal: Principal;
  try {
    principal = await resolveEmployeePrincipal(request.headers);
  } catch (error) {
    const authResponse = employeeAuthErrorResponse(error, requestId);
    return authResponse ?? schemaInvalidTable(requestId, "身份解析失败");
  }

  // 2. 解析 query 参数
  const url = new URL(request.url);
  const scopeTypeParam = url.searchParams.get("scope_type");
  const scopeRefParam = url.searchParams.get("scope_ref");
  const includeArchived = url.searchParams.get("include_archived") === "true";
  const limitParam = url.searchParams.get("limit");
  const limit = limitParam ? Number.parseInt(limitParam, 10) : 50;

  if (limitParam && (!Number.isInteger(limit) || limit <= 0 || limit > 200)) {
    return schemaInvalidTable(requestId, "limit 必须是 1-200 之间的整数");
  }

  // 3. 校验 scope_type
  let scopeType: MemoryScopeType | null = null;
  if (scopeTypeParam) {
    if (!VALID_SCOPE_TYPES.has(scopeTypeParam)) {
      return schemaInvalidTable(
        requestId,
        `scope_type 必须是 ${MEMORY_SCOPE_TYPES.join(" / ")} 之一`,
      );
    }
    scopeType = scopeTypeParam as MemoryScopeType;
  }

  // 4. 查询 MemoryEntry
  let entries: MemoryEntry[];
  if (scopeType) {
    entries = await listMemoryEntriesByScope(principal.tenantId, scopeType, scopeRefParam, {
      limit,
      includeArchived,
    });
  } else {
    // 无 scope_type 过滤：返回所有 scope 的 active Entry（按 updatedAt 降序）
    // 使用 user_preference scope 作为默认（用户级，跨 Agent）
    entries = await listMemoryEntriesByScope(principal.tenantId, "user_preference", null, {
      limit,
      includeArchived,
    });
  }

  // 5. 返回 200 + 投影列表
  const results = entries.map(projectEntry);
  return apiSuccess(
    { entries: results },
    {
      status: 200,
      headers: { [REQUEST_ID_HEADER]: requestId },
    },
  );
}
