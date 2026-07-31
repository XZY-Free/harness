import { createHash } from "node:crypto";

/**
 * V3.4 外部资料来源记录（蓝图 §5.4）。
 *
 * 每次外部资料访问（webFetch/webSearch/searchDocs/MCP）产出一份来源标记：
 * sourceUrl / fetchedAt / expiresAt / contentHash，供 agent 解释结论来源、
 * Studio 审计、external manifest layer 填充。只观测记录，不主动注入上下文
 * （webFetch 是按需工具调用，结果走 tool evidence）。
 */

export type ExternalSource = {
  sourceUrl: string;
  fetchedAt: string;
  expiresAt: string | null;
  contentHash: string;
  artifactPath?: string;
};

/** sha256 内容指纹（全 hex，稳定）。 */
export function computeContentHash(content: string): string {
  return createHash("sha256").update(content).digest("hex");
}

/**
 * 域名匹配：allowlist/blacklist 条目 d 匹配 host h 当 h === d 或 h 以 `.${d}` 结尾
 * （即 d 的子域）。条目小写、去空白后比较。
 */
export function matchDomain(host: string, entry: string): boolean {
  const h = host.toLowerCase();
  const d = entry.toLowerCase().replace(/^\./, "");
  if (!d) return false;
  return h === d || h.endsWith(`.${d}`);
}

/**
 * 构造一份来源记录。expiresAt 默认 24h（稳定资料）；dynamic=true 时 1h（动态资料）。
 * artifactPath 可选——原文落 artifact 时填，供审计回溯。
 */
export function buildExternalSource(params: {
  sourceUrl: string;
  content: string;
  fetchedAt?: Date;
  dynamic?: boolean;
  artifactPath?: string;
}): ExternalSource {
  const fetchedAt = params.fetchedAt ?? new Date();
  const ttlMs = params.dynamic ? 60 * 60 * 1000 : 24 * 60 * 60 * 1000;
  const expiresAt = new Date(fetchedAt.getTime() + ttlMs);
  return {
    sourceUrl: params.sourceUrl,
    fetchedAt: fetchedAt.toISOString(),
    expiresAt: expiresAt.toISOString(),
    contentHash: computeContentHash(params.content),
    artifactPath: params.artifactPath,
  };
}
