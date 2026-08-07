/**
 * GET /gateway/v1/tools/{tool_id}/schema — Runtime 读取 Tool Schema（阶段 6 S06-C04）。
 *
 * 事实源：
 * - ../v11-agentkit-platform/11-api-and-event-boundaries.md §3（Gateway API）、§2.5（成功与错误格式）。
 * - ../v11-agentkit-platform/12-capability-and-collaboration-api.md §3.2（Runtime Tool Schema 读取）。
 *
 * 行为：
 * - 解析 Bearer Token（Workload Token，audience=gateway）。
 * - 校验 Tool 存在且属于当前租户（跨租户隐藏为 404 CAPABILITY_NOT_ALLOWED）。
 * - 校验 Tool 有 currentSchemaRevisionId（无则 422 CAPABILITY_CONTENT_BLOCKED）。
 * - 支持 If-None-Match 短路径：客户端 ETag 与当前 revision 匹配 → 304 Not Modified。
 * - 成功后调用 recordCapabilityUse（capabilityType="tool"，schemaHash 从 revision 读取）。
 * - 返回 schema 投影 + ETag 头（`tool-schema-{revisionNo}`）。
 *
 * ETag 格式：`tool-schema-{revisionNo}`（与 Admin API 一致，复用 parseToolSchemaRevisionEtag）。
 *
 * 错误映射：
 * - 缺少/非法 Token → 401 AUTHENTICATION_REQUIRED
 * - Tool 不存在/跨租户 → 404 CAPABILITY_NOT_ALLOWED（隐藏式）
 * - Tool 无 currentSchemaRevisionId → 422 CAPABILITY_CONTENT_BLOCKED
 * - If-None-Match 格式非法 → 400 CATALOG_REVISION_INVALID
 * - ToolSchemaRevision 不存在（currentSchemaRevisionId 悬空）→ 422 CAPABILITY_CONTENT_BLOCKED
 */
import { REQUEST_ID_HEADER, apiSuccess, etagHeader, getRequestId } from "@/lib/http";
import {
  TOOL_SCHEMA_REVISION_ETAG_PREFIX,
  parseToolSchemaRevisionEtag,
} from "@/lib/admin/route-helpers";
import { recordCapabilityUse } from "@/lib/capability/capability-use-queries";
import { getCurrentToolSchemaRevision, getToolById } from "@/lib/capability/tool-queries";
import {
  type GatewayPrincipal,
  gatewayAuthErrorResponse,
  gatewayCapabilityContentBlockedTable,
  gatewayCapabilityNotAllowedTable,
  gatewayCatalogRevisionInvalidTable,
  resolveGatewayPrincipal,
} from "@/lib/gateway/route-helpers";

export const dynamic = "force-dynamic";

/** 路径参数上下文（与 admin tools/[tool_id] 一致：严格类型）。 */
interface RouteContext {
  params: Promise<{ tool_id: string }>;
}

/** 解析 If-None-Match 头，去掉弱验证前缀 `W/` 与引号，返回裸 ETag 值；缺失返回 null。 */
function parseIfNoneMatch(request: Request): string | null {
  const raw = request.headers.get("if-none-match");
  if (!raw || !raw.trim()) return null;
  return raw.trim().replace(/^W\//, "").replace(/^"|"$/g, "");
}

/** 投影 ToolSchemaRevision 为响应体（snake_case，与 Admin API 对齐）。 */
function projectSchemaRevision(revision: {
  id: string;
  toolId: string;
  revisionNo: number;
  description: string | null;
  inputSchemaJson: unknown;
  outputSchemaJson: unknown;
  schemaHash: string;
  riskMetadataJson: unknown;
  revisionState: string;
  createdBy: string;
  createdAt: Date;
  publishedAt: Date | null;
}): Record<string, unknown> {
  return {
    id: revision.id,
    tool_id: revision.toolId,
    revision_no: revision.revisionNo,
    description: revision.description,
    input_schema: revision.inputSchemaJson,
    output_schema: revision.outputSchemaJson,
    schema_hash: revision.schemaHash,
    risk_metadata: revision.riskMetadataJson,
    revision_state: revision.revisionState,
    created_by: revision.createdBy,
    created_at: revision.createdAt.toISOString(),
    published_at: revision.publishedAt?.toISOString() ?? null,
  };
}

export async function GET(request: Request, context: RouteContext): Promise<Response> {
  const requestId = getRequestId(request);
  const { tool_id: toolId } = await context.params;

  // 1. 解析 Gateway 身份（audience=gateway）
  let claims: GatewayPrincipal;
  try {
    claims = await resolveGatewayPrincipal(request.headers);
  } catch (err) {
    const authResp = gatewayAuthErrorResponse(err, requestId);
    if (authResp) return authResp;
    throw err;
  }

  // 2. 校验 Tool 存在且属于当前租户（跨租户隐藏为 404 CAPABILITY_NOT_ALLOWED）
  const tool = await getToolById({ tenantId: claims.tenantId, toolId });
  if (!tool) {
    return gatewayCapabilityNotAllowedTable(requestId, `Tool 不存在或无权访问: ${toolId}`);
  }

  // 3. 校验 Tool 有 currentSchemaRevisionId（无则 422 CAPABILITY_CONTENT_BLOCKED）
  if (!tool.currentSchemaRevisionId) {
    return gatewayCapabilityContentBlockedTable(
      requestId,
      `Tool ${toolId} 当前未发布 SchemaRevision`,
    );
  }

  // 4. 读取当前 SchemaRevision（跨租户隔离由 getToolSchemaRevisionById 内 join Tool 保证）
  const revision = await getCurrentToolSchemaRevision({
    tenantId: claims.tenantId,
    toolId,
  });
  if (!revision) {
    // currentSchemaRevisionId 悬空（数据异常）：统一返回 422 隐藏内部状态。
    return gatewayCapabilityContentBlockedTable(
      requestId,
      `Tool ${toolId} 当前 SchemaRevision 不可读`,
    );
  }

  // 5. If-None-Match 短路径：客户端 ETag 与当前 revisionNo 匹配 → 304 Not Modified
  const ifNoneMatch = parseIfNoneMatch(request);
  if (ifNoneMatch) {
    let parsedRevisionNo: number;
    try {
      parsedRevisionNo = parseToolSchemaRevisionEtag(ifNoneMatch);
    } catch (err) {
      return gatewayCatalogRevisionInvalidTable(
        requestId,
        err instanceof Error ? err.message : `If-None-Match 格式非法: ${ifNoneMatch}`,
      );
    }
    if (parsedRevisionNo === revision.revisionNo) {
      return new Response(null, {
        status: 304,
        headers: {
          [REQUEST_ID_HEADER]: requestId,
          ...etagHeader(`${TOOL_SCHEMA_REVISION_ETAG_PREFIX}${revision.revisionNo}`),
        },
      });
    }
  }

  // 6. 记录能力使用账本（capabilityType="tool"，schemaHash 从 revision 读取）
  //    sourceType="dynamic_discovery"（Gateway 通过 searchCatalog 发现后读取）。
  //    invocationId 必填：Gateway Token 必有 invocationId（resolveGatewayPrincipal 已收窄为 string）。
  await recordCapabilityUse({
    tenantId: claims.tenantId,
    invocationId: claims.invocationId,
    capabilityType: "tool",
    capabilityId: toolId,
    revisionId: revision.id,
    schemaHash: revision.schemaHash,
    contentHash: null,
    sourceType: "dynamic_discovery",
    sourceRef: `gateway:tools/${toolId}/schema`,
    selectionReasonCode: "explicit_select",
  });

  // 7. 返回 200 + ETag
  const body = projectSchemaRevision(revision);
  return apiSuccess(body, {
    status: 200,
    headers: {
      [REQUEST_ID_HEADER]: requestId,
      ...etagHeader(`${TOOL_SCHEMA_REVISION_ETAG_PREFIX}${revision.revisionNo}`),
    },
  });
}
