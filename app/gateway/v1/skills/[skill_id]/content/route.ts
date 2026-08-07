/**
 * GET /gateway/v1/skills/{skill_id}/content — Runtime 读取 Skill 内容（阶段 6 S06-C04）。
 *
 * 事实源：
 * - ../v11-agentkit-platform/11-api-and-event-boundaries.md §3（Gateway API）、§2.5（成功与错误格式）。
 * - ../v11-agentkit-platform/12-capability-and-collaboration-api.md §3.3（Runtime Skill Content 读取）。
 *
 * 行为：
 * - 解析 Bearer Token（Workload Token，audience=gateway）。
 * - 校验 Skill 存在且属于当前租户（跨租户隐藏为 404 CAPABILITY_NOT_ALLOWED）。
 * - 校验 Skill lifecycleState=enabled（非 enabled 视为不可读 → 404 CAPABILITY_NOT_ALLOWED 隐藏式）。
 * - 校验 Skill 有 currentVersionId（无则 422 CAPABILITY_CONTENT_BLOCKED）。
 * - 校验 SkillVersion revisionState=published（draft/withdrawn → 422 CAPABILITY_CONTENT_BLOCKED）。
 * - 支持 If-None-Match 短路径：客户端 ETag 与当前 versionNo 匹配 → 304 Not Modified。
 * - 成功后调用 recordCapabilityUse（capabilityType="skill"，contentHash 从 version 读取）。
 * - 返回内容投影 + ETag 头（`skill-content-{versionNo}`）。
 *
 * ETag 格式：`skill-content-{versionNo}`（Gateway 专属内容版本 ETag）。
 * 与 Admin API 的 `skill-{skill.versionNo}` 不同：前者绑定 SkillVersion 内容版本，
 * 后者绑定 Skill 资源乐观锁版本（PATCH 元数据后即变）。
 *
 * 错误映射：
 * - 缺少/非法 Token → 401 AUTHENTICATION_REQUIRED
 * - Skill 不存在/跨租户/lifecycle 非 enabled → 404 CAPABILITY_NOT_ALLOWED（隐藏式）
 * - Skill 无 currentVersionId 或 SkillVersion 非 published → 422 CAPABILITY_CONTENT_BLOCKED
 * - If-None-Match 格式非法 → 400 CATALOG_REVISION_INVALID
 */
import { REQUEST_ID_HEADER, apiSuccess, etagHeader, getRequestId } from "@/lib/http";
import { recordCapabilityUse } from "@/lib/capability/capability-use-queries";
import { getCurrentSkillVersion, getSkillById } from "@/lib/capability/skill-queries";
import {
  type GatewayPrincipal,
  gatewayAuthErrorResponse,
  gatewayCapabilityContentBlockedTable,
  gatewayCapabilityNotAllowedTable,
  gatewayCatalogRevisionInvalidTable,
  resolveGatewayPrincipal,
} from "@/lib/gateway/route-helpers";

export const dynamic = "force-dynamic";

/** Skill 内容版本 ETag 前缀（Gateway 专属，绑定 SkillVersion.versionNo）。 */
const SKILL_CONTENT_ETAG_PREFIX = "skill-content-";

/** 路径参数上下文（与 admin skills/[skill_id] 一致：严格类型）。 */
interface RouteContext {
  params: Promise<{ skill_id: string }>;
}

/** 解析 If-None-Match 头，去掉弱验证前缀 `W/` 与引号，返回裸 ETag 值；缺失返回 null。 */
function parseIfNoneMatch(request: Request): string | null {
  const raw = request.headers.get("if-none-match");
  if (!raw || !raw.trim()) return null;
  return raw.trim().replace(/^W\//, "").replace(/^"|"$/g, "");
}

/** 从 skill-content ETag 提取 versionNo；非法抛错（route 层捕获返回 400）。 */
function parseSkillContentEtag(etag: string): number {
  if (!etag.startsWith(SKILL_CONTENT_ETAG_PREFIX)) {
    throw new Error(`非法 SkillContent ETag: ${etag}（期望前缀 ${SKILL_CONTENT_ETAG_PREFIX}）`);
  }
  const versionStr = etag.slice(SKILL_CONTENT_ETAG_PREFIX.length);
  const versionNo = Number.parseInt(versionStr, 10);
  if (!Number.isFinite(versionNo) || versionNo <= 0) {
    throw new Error(`非法 SkillContent ETag 版本号: ${etag}`);
  }
  return versionNo;
}

/** 投影 Skill + SkillVersion 为响应体（snake_case）。 */
function projectSkillContent(
  skill: {
    id: string;
    skillKey: string;
    displayName: string;
    lifecycleState: string;
  },
  version: {
    id: string;
    versionNo: number;
    contentRef: string;
    contentHash: string;
    manifestJson: unknown;
    revisionState: string;
    publishedAt: Date | null;
  },
): Record<string, unknown> {
  return {
    skill_id: skill.id,
    skill_key: skill.skillKey,
    display_name: skill.displayName,
    lifecycle_state: skill.lifecycleState,
    version: {
      id: version.id,
      version_no: version.versionNo,
      content_ref: version.contentRef,
      content_hash: version.contentHash,
      manifest: version.manifestJson,
      revision_state: version.revisionState,
      published_at: version.publishedAt?.toISOString() ?? null,
    },
  };
}

export async function GET(request: Request, context: RouteContext): Promise<Response> {
  const requestId = getRequestId(request);
  const { skill_id: skillId } = await context.params;

  // 1. 解析 Gateway 身份（audience=gateway）
  let claims: GatewayPrincipal;
  try {
    claims = await resolveGatewayPrincipal(request.headers);
  } catch (err) {
    const authResp = gatewayAuthErrorResponse(err, requestId);
    if (authResp) return authResp;
    throw err;
  }

  // 2. 校验 Skill 存在且属于当前租户（跨租户隐藏为 404 CAPABILITY_NOT_ALLOWED）
  const skill = await getSkillById({ tenantId: claims.tenantId, skillId });
  if (!skill) {
    return gatewayCapabilityNotAllowedTable(requestId, `Skill 不存在或无权访问: ${skillId}`);
  }

  // 3. 校验 Skill lifecycleState=enabled（非 enabled 视为不可读，统一隐藏为 404）
  //    draft/disabled/retired 不应被 Runtime 读取；隐藏存在状态避免信息泄露。
  if (skill.lifecycleState !== "enabled") {
    return gatewayCapabilityNotAllowedTable(requestId, `Skill 不存在或无权访问: ${skillId}`);
  }

  // 4. 校验 Skill 有 currentVersionId（无则 422 CAPABILITY_CONTENT_BLOCKED）
  if (!skill.currentVersionId) {
    return gatewayCapabilityContentBlockedTable(requestId, `Skill ${skillId} 当前未发布内容版本`);
  }

  // 5. 读取当前 SkillVersion（跨租户隔离由 getSkillVersionById 内 join Skill 保证）
  const version = await getCurrentSkillVersion({
    tenantId: claims.tenantId,
    skillId,
  });
  if (!version) {
    // currentVersionId 悬空（数据异常）：统一返回 422 隐藏内部状态。
    return gatewayCapabilityContentBlockedTable(requestId, `Skill ${skillId} 当前内容版本不可读`);
  }

  // 6. 校验 SkillVersion revisionState=published（draft/withdrawn → 422）
  if (version.revisionState !== "published") {
    return gatewayCapabilityContentBlockedTable(
      requestId,
      `Skill ${skillId} 版本 ${version.versionNo} 状态为 ${version.revisionState}，仅 published 可读`,
    );
  }

  // 7. If-None-Match 短路径：客户端 ETag 与当前 versionNo 匹配 → 304 Not Modified
  const ifNoneMatch = parseIfNoneMatch(request);
  if (ifNoneMatch) {
    let parsedVersionNo: number;
    try {
      parsedVersionNo = parseSkillContentEtag(ifNoneMatch);
    } catch (err) {
      return gatewayCatalogRevisionInvalidTable(
        requestId,
        err instanceof Error ? err.message : `If-None-Match 格式非法: ${ifNoneMatch}`,
      );
    }
    if (parsedVersionNo === version.versionNo) {
      return new Response(null, {
        status: 304,
        headers: {
          [REQUEST_ID_HEADER]: requestId,
          ...etagHeader(`${SKILL_CONTENT_ETAG_PREFIX}${version.versionNo}`),
        },
      });
    }
  }

  // 8. 记录能力使用账本（capabilityType="skill"，contentHash 从 version 读取）
  //    sourceType="dynamic_discovery"（Gateway 通过 searchCatalog 发现后读取）。
  //    invocationId 必填：Gateway Token 必有 invocationId（resolveGatewayPrincipal 已收窄为 string）。
  await recordCapabilityUse({
    tenantId: claims.tenantId,
    invocationId: claims.invocationId,
    capabilityType: "skill",
    capabilityId: skillId,
    revisionId: version.id,
    contentHash: version.contentHash,
    schemaHash: null,
    sourceType: "dynamic_discovery",
    sourceRef: `gateway:skills/${skillId}/content`,
    selectionReasonCode: "explicit_select",
  });

  // 9. 返回 200 + ETag
  const body = projectSkillContent(skill, version);
  return apiSuccess(body, {
    status: 200,
    headers: {
      [REQUEST_ID_HEADER]: requestId,
      ...etagHeader(`${SKILL_CONTENT_ETAG_PREFIX}${version.versionNo}`),
    },
  });
}
