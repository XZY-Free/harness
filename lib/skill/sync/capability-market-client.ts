/**
 * capability-market 同步源 HTTP 客户端（02 文档 §二、§三）。
 *
 * 只调用 `/api/capabilities` 族接口,不调用旧 `/api/skills`、`/files`、`skill-access-events`。
 * 仅服务后台手动同步（lib/skill/sync/sync-service）,运行时（chat/resolver/tools）
 * 永远不引用本模块。
 *
 * 失败语义（fail-closed）：endpoint 未配置 / 非 2xx / 超时 / 响应非法 → 抛错,
 * 由 sync-service 捕获后计入单 asset 失败,不中断整批同步。
 *
 * 接口契约见 capability-market `apps/api/src/capabilities/capabilities.service.ts`：
 * - GET /api/capabilities?asset_type=skill&scope=syncable → { items, total, limit, offset }
 * - POST /api/capabilities/check-updates → { items: CheckUpdatesItem[] }
 * - POST /api/capabilities/sync → { items: SyncItem[] }
 * - GET /api/capabilities/:id/versions/:version/artifact → zip 流（响应头 X-Content-Hash/ETag）
 */

import { capmAuthHeaders } from "@/lib/capability-market/auth";
import { capabilityMarketConfig } from "@/lib/config";

/** 同步源未配置或不可用。 */
export class CapabilityMarketClientError extends Error {}

/**
 * 同步请求鉴权头。
 *
 * 优先请求作用域用户登录 token；兜底 env `NEX_CAPABILITY_MARKET_TOKEN`
 * （capm 未接入 auth-center 校验用户 token 期间；联调后删除该 env）。
 */
function authHeaders(): Record<string, string> {
  const auth = capmAuthHeaders(capabilityMarketConfig.token);
  return { accept: "application/json", authorization: auth.authorization };
}

function requireEndpoint(): string {
  const endpoint = capabilityMarketConfig.endpoint;
  if (!endpoint) {
    throw new CapabilityMarketClientError(
      "capability-market endpoint 未配置（NEX_CAPABILITY_MARKET_ENDPOINT）",
    );
  }
  return endpoint;
}

async function fetchJson<T>(url: string, init: RequestInit): Promise<T> {
  const resp = await fetch(url, {
    ...init,
    signal: AbortSignal.timeout(capabilityMarketConfig.timeoutMs),
  });
  if (!resp.ok) {
    throw new CapabilityMarketClientError(
      `capability-market 返回 ${resp.status}: ${resp.statusText}（${url}）`,
    );
  }
  return (await resp.json()) as T;
}

// ─── 列表接口 ────────────────────────────────────────────────

/** capability-market `CapabilityListItem`（snake_case,仅声明消费子集）。 */
export interface CapabilityListItem {
  asset_id: string;
  asset_type: string;
  name: string;
  display_name: string | null;
  description: string | null;
  category: string | null;
  latest_version: string | null;
  resolved_version: string | null;
  resolved_version_id: string | null;
  resolved_content_hash: string | null;
  access_state: "allowed" | "blocked" | "fixed_only";
  restriction_type: string | null;
  rule_id: string | null;
  tags: string[] | null;
}

interface CapabilitiesListResponse {
  items: CapabilityListItem[];
  total: number;
  limit: number;
  offset: number;
}

/**
 * 分页拉取所有可同步资产（asset_type + scope=syncable）。
 * scope=syncable 已在平台侧过滤掉 blocked 资产;hide 资产任何 scope 不可见。
 *
 * @param assetType 资产类型（skill / tool / mcp；默认 skill，兼容既有调用方）
 */
export async function listSyncableAssets(
  assetType: "skill" | "tool" | "mcp" = "skill",
): Promise<CapabilityListItem[]> {
  const endpoint = requireEndpoint();
  const out: CapabilityListItem[] = [];
  const limit = 100;
  let offset = 0;
  // 上限保护：最多 50 页（5000 个资产）,避免异常无限循环
  for (let page = 0; page < 50; page++) {
    const url =
      `${endpoint}/capabilities?asset_type=${assetType}&scope=syncable` +
      `&limit=${limit}&offset=${offset}`;
    const body = await fetchJson<CapabilitiesListResponse>(url, {
      method: "GET",
      headers: authHeaders(),
    });
    if (!body || !Array.isArray(body.items)) {
      throw new CapabilityMarketClientError("capability-market 列表响应格式非法：缺少 items");
    }
    out.push(...body.items);
    if (body.items.length < limit) break;
    offset += limit;
  }
  return out;
}

/** 兼容既有调用方：拉取可同步 Skill。 */
export async function listSyncableSkills(): Promise<CapabilityListItem[]> {
  return listSyncableAssets("skill");
}

// ─── check-updates ──────────────────────────────────────────

export type CheckUpdateStatus = "unchanged" | "changed" | "blocked" | "not_found";

export interface CheckUpdatesItem {
  asset_id: string;
  status: CheckUpdateStatus;
  latest_version: string | null;
  latest_content_hash: string | null;
  rule_id: string | null;
  restriction_type: string | null;
  error_code: string | null;
  requested_version: string;
  requested_content_hash: string;
}

interface CheckUpdatesResponse {
  items: CheckUpdatesItem[];
}

/** 批量检查本地缓存是否过期。每项 { asset_id, version, content_hash }。 */
export async function checkUpdates(
  items: Array<{ asset_id: string; version: string; content_hash: string }>,
): Promise<CheckUpdatesItem[]> {
  if (items.length === 0) return [];
  const endpoint = requireEndpoint();
  const body = await fetchJson<CheckUpdatesResponse>(`${endpoint}/capabilities/check-updates`, {
    method: "POST",
    headers: { ...authHeaders(), "content-type": "application/json" },
    body: JSON.stringify({ items }),
  });
  if (!body || !Array.isArray(body.items)) {
    throw new CapabilityMarketClientError("capability-market check-updates 响应格式非法");
  }
  return body.items;
}

// ─── sync manifest ──────────────────────────────────────────

/** capm tool_detail（asset_type=tool 时的详情）。 */
export interface CapmToolDetail {
  tool_key: string;
  plugin_name: string | null;
  plugin_version: string | null;
  entry_command: string | null;
  runtime: string | null;
  input_schema: unknown;
  output_schema: unknown;
  risk_level: string | null;
}

/** capm mcp tools 快照项。 */
export interface CapmMcpToolSnapshot {
  name: string;
  description?: string | null;
  input_schema?: unknown;
  input_schema_hash?: string;
  /** MCP tool annotations（若 capm 采集）；当前 capm probe 未采集，可能缺失。 */
  annotations?: {
    readOnlyHint?: boolean;
    destructiveHint?: boolean;
    openWorldHint?: boolean;
    idempotentHint?: boolean;
  };
  output_schema?: unknown;
}

/** capm mcp_detail（asset_type=mcp 时的详情）。 */
export interface CapmMcpDetail {
  transport: string | null;
  endpoint_url: string | null;
  auth_type: string | null;
  protocol_version: string | null;
  server_info: unknown;
  tools: CapmMcpToolSnapshot[] | null;
  probe_state: string | null;
  registry_source: string | null;
}

export interface SyncItem {
  asset_id: string;
  asset_type: string;
  asset_name: string;
  resolved_version: string;
  version_id: string;
  content_hash: string;
  version_state: string;
  risk_level: string | null;
  package_size: number | null;
  etag: string | null;
  artifact_download_path: string;
  skill_detail: {
    entry_file: string;
    runtime_requirements: string | null;
    permission_policy: string | null;
    tags: string[] | null;
  } | null;
  tool_detail: CapmToolDetail | null;
  mcp_detail: CapmMcpDetail | null;
  rule_id: string | null;
  restriction_type: string | null;
  error_code?: string | null;
  error_message?: string | null;
}

interface SyncResponse {
  items: SyncItem[];
}

/** 批量获取同步元数据（manifest、hash、artifact 下载路径）。 */
export async function syncManifests(assetIds: string[]): Promise<SyncItem[]> {
  if (assetIds.length === 0) return [];
  const endpoint = requireEndpoint();
  const body = await fetchJson<SyncResponse>(`${endpoint}/capabilities/sync`, {
    method: "POST",
    headers: { ...authHeaders(), "content-type": "application/json" },
    body: JSON.stringify({ items: assetIds.map((id) => ({ asset_id: id })) }),
  });
  if (!body || !Array.isArray(body.items)) {
    throw new CapabilityMarketClientError("capability-market sync 响应格式非法");
  }
  return body.items;
}

// ─── artifact 下载 ──────────────────────────────────────────

export interface ArtifactDownload {
  /** zip 字节内容。 */
  buffer: Buffer;
  /** 版本 content_hash（响应头 X-Content-Hash）。 */
  contentHash: string;
  /** COS ETag（响应头 ETag）,用于下次 If-None-Match。 */
  etag: string | null;
}

/**
 * 下载版本 artifact zip。
 * 失败语义：404 → null（资产/版本不存在或被 hide）;其它非 2xx → 抛错。
 */
export async function downloadArtifact(
  assetId: string,
  version: string,
): Promise<ArtifactDownload | null> {
  const endpoint = requireEndpoint();
  const url = `${endpoint}/capabilities/${encodeURIComponent(assetId)}/versions/${encodeURIComponent(version)}/artifact`;
  const resp = await fetch(url, {
    method: "GET",
    headers: authHeaders(),
    signal: AbortSignal.timeout(capabilityMarketConfig.timeoutMs),
  });
  if (resp.status === 404) return null;
  if (!resp.ok) {
    throw new CapabilityMarketClientError(
      `artifact 下载返回 ${resp.status}: ${resp.statusText}（${assetId}@${version}）`,
    );
  }
  const arrayBuf = await resp.arrayBuffer();
  const contentHash = resp.headers.get("x-content-hash") ?? "";
  const etag = resp.headers.get("etag");
  return { buffer: Buffer.from(arrayBuf), contentHash, etag };
}
