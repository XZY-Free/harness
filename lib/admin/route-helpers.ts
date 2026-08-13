/**
 * Admin API route handler 公共助手（S03-C05）。
 *
 * 事实源：docs/architecture/api-and-events.md §6、§9、
 * docs/architecture/security.md §5。
 *
 * 职责：
 * - resolveAdminPrincipalAsync：admin audience 双身份解析（SSO Session 或 Service Identity Workload Token）。
 * - requireAdminActionScope：统一 action scope 校验入口（Principal 走 role_action_binding，
 * WorkloadPrincipal callerType=service 走 CICD_SERVICE_ALLOWED_ACTIONS 白名单）。
 * - parseRouteSetEtag / parseAgentRevisionEtag：从 ETag 字符串提取版本号。
 *
 * 安全边界：
 * - admin audience 同时支持管理员 SSO 和 CI/CD Service Identity；两者都通过 requireActionScope 校验。
 * - 缺少身份 → 401 AUTHENTICATION_REQUIRED；缺少 action scope → 403 ACTION_SCOPE_DENIED。
 * - ETag 格式不匹配 → 400 REQUEST_SCHEMA_INVALID（fail-closed，不静默接受）。
 */
import { type ApiErrorCode, errorDefinition } from "@/lib/error-codes";
import { apiError } from "@/lib/http";
import type { ActionCode, ResourceScopeType } from "@/lib/identity/action-codes";
import { requireActionScope } from "@/lib/identity/authorization";
import {
 AuthenticationError,
 type Principal,
 type WorkloadPrincipal,
 resolvePrincipal,
 resolveWorkloadPrincipal,
} from "@/lib/identity/resolver";
import { WorkloadTokenError } from "@/lib/identity/workload-token";

// ─── 身份解析 ──────────────────────────────────────────────

/** admin audience 解析后的主体（SSO 用户或 Service Identity）。 */
export type AdminPrincipal = Principal | WorkloadPrincipal;

/**
 * 解析 admin audience 主体：优先 Service Identity Bearer Token，否则 SSO trusted-headers。
 *
 * 分发规则：
 * - 携带 `Authorization: Bearer <token>` → resolveWorkloadPrincipal(headers, "admin")。
 * - type=service：CI/CD Service Identity（如 cicd）。
 * - type=runtime/gateway：admin audience 不允许，assertAudienceMatch 通过但 callerType=workload，
 * requireActionScope 会拒绝（workload_not_action_scoped）。
 * - 无 Authorization → resolvePrincipal(headers, "admin")（SSO 管理员）。
 *
 * @throws AuthenticationError 缺少身份（SSO 模式缺 header）
 * @throws WorkloadTokenError Bearer Token 解析/过期/audience 不匹配
 */
export async function resolveAdminPrincipalAsync(headers: Headers): Promise<AdminPrincipal> {
 const authHeader = headers.get("authorization");
 if (authHeader?.trim().toLowerCase().startsWith("bearer ")) {
 return resolveWorkloadPrincipal(headers, "admin");
 }
 return resolvePrincipal(headers, "admin");
}

/**
 * 把身份解析错误（AuthenticationError / WorkloadTokenError）转成 401 响应。
 * 非身份错误返回 null（调用方应向上抛）。
 */
export function adminAuthErrorResponse(error: unknown, requestId: string): Response | null {
 if (error instanceof AuthenticationError) {
 return apiError("AUTHENTICATION_REQUIRED", error.message, { requestId });
 }
 if (error instanceof WorkloadTokenError) {
 return apiError("AUTHENTICATION_REQUIRED", `Workload Token 无效: ${error.message}`, {
 requestId,
 });
 }
 return null;
}

// ─── action scope 校验 ────────────────────────────────────

/**
 * 校验 admin 主体是否拥有指定 action scope，失败返回 403 响应。
 *
 * 复用 requireActionScope：
 * - Principal → 查 role_action_binding
 * - WorkloadPrincipal callerType=service → 查 CICD_SERVICE_ALLOWED_ACTIONS
 * - WorkloadPrincipal callerType=workload → 拒绝（workload_not_action_scoped）
 */
export async function requireAdminActionScope(
 principal: AdminPrincipal,
 actionCode: ActionCode,
 resource: { type: ResourceScopeType; id: string },
 requestId: string,
): Promise<{ ok: true; principal: AdminPrincipal } | { ok: false; response: Response }> {
 const result = await requireActionScope(principal, { actionCode, resource }, requestId);
 if (result.ok) {
 return { ok: true, principal };
 }
 return { ok: false, response: result.response };
}

// ─── ETag 解析 ────────────────────────────────────────────

/** RouteSet ETag 前缀：`route-set-{versionNo}`。 */
export const ROUTE_SET_ETAG_PREFIX = "route-set-";

/** AgentRevision ETag 前缀：`agent-revision-{revisionNo}`。 */
export const AGENT_REVISION_ETAG_PREFIX = "agent-revision-";

/** RuntimeRevision ETag 前缀：`runtime-revision-{revisionNo}`（S05-C06）。 */
export const RUNTIME_REVISION_ETAG_PREFIX = "runtime-revision-";

/** Skill ETag 前缀：`skill-{versionNo}`（阶段 6 S06-C01）。 */
export const SKILL_ETAG_PREFIX = "skill-";

/** Tool ETag 前缀：`tool-{versionNo}`（阶段 6 S06-C02）。 */
export const TOOL_ETAG_PREFIX = "tool-";

/** ToolSchemaRevision ETag 前缀：`tool-schema-{revisionNo}`（阶段 6 S06-C02）。 */
export const TOOL_SCHEMA_REVISION_ETAG_PREFIX = "tool-schema-";

/** ToolProvider ETag 前缀：`tool-provider-{versionNo}`（阶段 6 S06-C02）。 */
export const TOOL_PROVIDER_ETAG_PREFIX = "tool-provider-";

/** Connection ETag 前缀：`connection-{versionNo}`（阶段 6 S06-C02）。 */
export const CONNECTION_ETAG_PREFIX = "connection-";

/**
 * Catalog Revision ETag 前缀：`catalog-{tenantId}-{audience}-{revisionNo}`（阶段 6 S06-C03）。
 *
 * 员工目录 API 用此 ETag 实现 If-None-Match 短路径 304。
 * 完整 ETag 值由 route handler 拼接（含 tenantId 与 audience，保证跨租户/跨受众不混淆）。
 */
export const CATALOG_REVISION_ETAG_PREFIX = "catalog-";

/**
 * 从 RouteSet ETag 字符串提取 versionNo。
 *
 * ETag 格式：`route-set-{versionNo}`（如 `route-set-13`）。
 * 解析失败抛错（route 层应捕获并返回 400 REQUEST_SCHEMA_INVALID）。
 *
 * @throws Error ETag 格式非法
 */
export function parseRouteSetEtag(etag: string): number {
 if (!etag.startsWith(ROUTE_SET_ETAG_PREFIX)) {
 throw new Error(`非法 RouteSet ETag: ${etag}（期望前缀 ${ROUTE_SET_ETAG_PREFIX}）`);
 }
 const versionStr = etag.slice(ROUTE_SET_ETAG_PREFIX.length);
 const versionNo = Number.parseInt(versionStr, 10);
 if (!Number.isFinite(versionNo) || versionNo <= 0) {
 throw new Error(`非法 RouteSet ETag 版本号: ${etag}`);
 }
 return versionNo;
}

/**
 * 从 AgentRevision ETag 字符串提取 revisionNo。
 *
 * ETag 格式：`agent-revision-{revisionNo}`（如 `agent-revision-19`）。
 * 解析失败抛错（route 层应捕获并返回 400 REQUEST_SCHEMA_INVALID）。
 *
 * @throws Error ETag 格式非法
 */
export function parseAgentRevisionEtag(etag: string): number {
 if (!etag.startsWith(AGENT_REVISION_ETAG_PREFIX)) {
 throw new Error(`非法 AgentRevision ETag: ${etag}（期望前缀 ${AGENT_REVISION_ETAG_PREFIX}）`);
 }
 const revisionStr = etag.slice(AGENT_REVISION_ETAG_PREFIX.length);
 const revisionNo = Number.parseInt(revisionStr, 10);
 if (!Number.isFinite(revisionNo) || revisionNo <= 0) {
 throw new Error(`非法 AgentRevision ETag 版本号: ${etag}`);
 }
 return revisionNo;
}

/**
 * 从 RuntimeRevision ETag 字符串提取 revisionNo（S05-C06）。
 *
 * ETag 格式：`runtime-revision-{revisionNo}`（如 `runtime-revision-7`）。
 * 解析失败抛错（route 层应捕获并返回 400 REQUEST_SCHEMA_INVALID）。
 *
 * @throws Error ETag 格式非法
 */
export function parseRuntimeRevisionEtag(etag: string): number {
 if (!etag.startsWith(RUNTIME_REVISION_ETAG_PREFIX)) {
 throw new Error(
 `非法 RuntimeRevision ETag: ${etag}（期望前缀 ${RUNTIME_REVISION_ETAG_PREFIX}）`,
 );
 }
 const revisionStr = etag.slice(RUNTIME_REVISION_ETAG_PREFIX.length);
 const revisionNo = Number.parseInt(revisionStr, 10);
 if (!Number.isFinite(revisionNo) || revisionNo <= 0) {
 throw new Error(`非法 RuntimeRevision ETag 版本号: ${etag}`);
 }
 return revisionNo;
}

/**
 * 从 Skill ETag 字符串提取 versionNo（阶段 6 S06-C01）。
 *
 * ETag 格式：`skill-{versionNo}`（如 `skill-3`）。
 * 解析失败抛错（route 层应捕获并返回 400 REQUEST_SCHEMA_INVALID）。
 *
 * @throws Error ETag 格式非法
 */
export function parseSkillEtag(etag: string): number {
 if (!etag.startsWith(SKILL_ETAG_PREFIX)) {
 throw new Error(`非法 Skill ETag: ${etag}（期望前缀 ${SKILL_ETAG_PREFIX}）`);
 }
 const versionStr = etag.slice(SKILL_ETAG_PREFIX.length);
 const versionNo = Number.parseInt(versionStr, 10);
 if (!Number.isFinite(versionNo) || versionNo <= 0) {
 throw new Error(`非法 Skill ETag 版本号: ${etag}`);
 }
 return versionNo;
}

/**
 * 从 Tool ETag 字符串提取 versionNo（阶段 6 S06-C02）。
 *
 * ETag 格式：`tool-{versionNo}`（如 `tool-3`）。
 * 解析失败抛错（route 层应捕获并返回 400 REQUEST_SCHEMA_INVALID）。
 *
 * @throws Error ETag 格式非法
 */
export function parseToolEtag(etag: string): number {
 if (!etag.startsWith(TOOL_ETAG_PREFIX)) {
 throw new Error(`非法 Tool ETag: ${etag}（期望前缀 ${TOOL_ETAG_PREFIX}）`);
 }
 const versionStr = etag.slice(TOOL_ETAG_PREFIX.length);
 const versionNo = Number.parseInt(versionStr, 10);
 if (!Number.isFinite(versionNo) || versionNo <= 0) {
 throw new Error(`非法 Tool ETag 版本号: ${etag}`);
 }
 return versionNo;
}

/**
 * 从 ToolSchemaRevision ETag 字符串提取 revisionNo（阶段 6 S06-C02）。
 *
 * ETag 格式：`tool-schema-{revisionNo}`（如 `tool-schema-2`）。
 * 解析失败抛错（route 层应捕获并返回 400 REQUEST_SCHEMA_INVALID）。
 *
 * @throws Error ETag 格式非法
 */
export function parseToolSchemaRevisionEtag(etag: string): number {
 if (!etag.startsWith(TOOL_SCHEMA_REVISION_ETAG_PREFIX)) {
 throw new Error(
 `非法 ToolSchemaRevision ETag: ${etag}（期望前缀 ${TOOL_SCHEMA_REVISION_ETAG_PREFIX}）`,
 );
 }
 const revisionStr = etag.slice(TOOL_SCHEMA_REVISION_ETAG_PREFIX.length);
 const revisionNo = Number.parseInt(revisionStr, 10);
 if (!Number.isFinite(revisionNo) || revisionNo <= 0) {
 throw new Error(`非法 ToolSchemaRevision ETag 版本号: ${etag}`);
 }
 return revisionNo;
}

/**
 * 从 ToolProvider ETag 字符串提取 versionNo（阶段 6 S06-C02）。
 *
 * ETag 格式：`tool-provider-{versionNo}`（如 `tool-provider-3`）。
 * 解析失败抛错（route 层应捕获并返回 400 REQUEST_SCHEMA_INVALID）。
 *
 * @throws Error ETag 格式非法
 */
export function parseToolProviderEtag(etag: string): number {
 if (!etag.startsWith(TOOL_PROVIDER_ETAG_PREFIX)) {
 throw new Error(`非法 ToolProvider ETag: ${etag}（期望前缀 ${TOOL_PROVIDER_ETAG_PREFIX}）`);
 }
 const versionStr = etag.slice(TOOL_PROVIDER_ETAG_PREFIX.length);
 const versionNo = Number.parseInt(versionStr, 10);
 if (!Number.isFinite(versionNo) || versionNo <= 0) {
 throw new Error(`非法 ToolProvider ETag 版本号: ${etag}`);
 }
 return versionNo;
}

/**
 * 从 Connection ETag 字符串提取 versionNo（阶段 6 S06-C02）。
 *
 * ETag 格式：`connection-{versionNo}`（如 `connection-3`）。
 * 解析失败抛错（route 层应捕获并返回 400 REQUEST_SCHEMA_INVALID）。
 *
 * @throws Error ETag 格式非法
 */
export function parseConnectionEtag(etag: string): number {
 if (!etag.startsWith(CONNECTION_ETAG_PREFIX)) {
 throw new Error(`非法 Connection ETag: ${etag}（期望前缀 ${CONNECTION_ETAG_PREFIX}）`);
 }
 const versionStr = etag.slice(CONNECTION_ETAG_PREFIX.length);
 const versionNo = Number.parseInt(versionStr, 10);
 if (!Number.isFinite(versionNo) || versionNo <= 0) {
 throw new Error(`非法 Connection ETag 版本号: ${etag}`);
 }
 return versionNo;
}

/**
 * 构造 Catalog Revision ETag 字符串（阶段 6 S06-C03）。
 *
 * ETag 格式：`catalog-{tenantId}-{audience}-{revisionNo}`
 * （如 `catalog-00000000-0000-4000-8000-000000000000-employee-7`）。
 * 客户端用此值作 If-None-Match 短路径 304。
 */
export function buildCatalogRevisionEtag(
 tenantId: string,
 audience: "employee" | "runtime",
 revisionNo: number,
): string {
 return `${CATALOG_REVISION_ETAG_PREFIX}${tenantId}-${audience}-${revisionNo}`;
}

/**
 * 从 Catalog Revision ETag 字符串提取 revisionNo（阶段 6 S06-C03）。
 *
 * ETag 格式：`catalog-{tenantId}-{audience}-{revisionNo}`。
 * 解析失败抛错（route 层应捕获并返回 400 CATALOG_REVISION_INVALID）。
 *
 * @throws Error ETag 格式非法
 */
export function parseCatalogRevisionEtag(etag: string): number {
 if (!etag.startsWith(CATALOG_REVISION_ETAG_PREFIX)) {
 throw new Error(
 `非法 Catalog Revision ETag: ${etag}（期望前缀 ${CATALOG_REVISION_ETAG_PREFIX}）`,
 );
 }
 // 形如 catalog-{tenantId}-{audience}-{revisionNo}：tenantId 含 4 个 '-'，audience 无 '-'，revisionNo 无 '-'。
 // 直接取最后一个 '-' 后的部分作为 revisionNo。
 const body = etag.slice(CATALOG_REVISION_ETAG_PREFIX.length);
 const lastDashIdx = body.lastIndexOf("-");
 if (lastDashIdx <= 0) {
 throw new Error(`非法 Catalog Revision ETag: ${etag}`);
 }
 const revisionStr = body.slice(lastDashIdx + 1);
 const revisionNo = Number.parseInt(revisionStr, 10);
 if (!Number.isFinite(revisionNo) || revisionNo < 0) {
 throw new Error(`非法 Catalog Revision ETag 版本号: ${etag}`);
 }
 return revisionNo;
}

// ─── 错误响应工具 ──────────────────────────────────────────

/**
 * 构造 400 REQUEST_SCHEMA_INVALID 响应（请求体校验失败）。
 */
export function schemaInvalidTable(requestId: string, message: string): Response {
 return apiError("REQUEST_SCHEMA_INVALID", message, { requestId });
}

/**
 * 构造 412 ETAG_MISMATCH 响应（乐观锁冲突）。
 */
export function etagMismatchTable(requestId: string, message: string): Response {
 return apiError("ETAG_MISMATCH", message, { requestId });
}

/**
 * 判断错误码是否 retryable（用于决定是否 failRecord 幂等记录）。
 */
export function isRetryableErrorCode(code: ApiErrorCode): boolean {
 return errorDefinition(code).retryable;
}
