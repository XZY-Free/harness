/**
 * V11 网络出口策略（S12-W05）。
 *
 * 事实源：../v11-agentkit-platform/14-production-operations-security-and-retention.md §5
 * （Tool/网络出口按 Agent、租户、Environment 和策略 allowlist 强制；
 * 空 allowlist 表示全拒绝）。
 *
 * 职责：
 * - 定义 NetworkPolicy 结构化 schema（与 EnvironmentDefinition.networkPolicyJson 对齐）。
 * - resolveEgressPolicy：按 environment → tenant → agent 优先级合并策略。
 * - assertEgressAllowed：校验目标 host 是否允许出站；空 allowlist 全拒绝（fail-closed）。
 * - assertToolEgressAllowed：校验 Tool 调用目标 URL 是否允许。
 *
 * 不变量：
 * - allowEgress=false 时所有出站拒绝（默认 fail-closed）。
 * - allowDomains 为空数组表示全拒绝（即使 allowEgress=true）。
 * - denyDomains 优先于 allowDomains：命中 deny 立即拒绝。
 * - 解析失败（policy 缺失/格式非法）一律拒绝。
 *
 * 与 EnvironmentDefinition.networkPolicyJson 的关系：
 * - EnvironmentDefinition 持久化 networkPolicyJson（裸 JSON）。
 * - 本模块提供结构化类型与校验，运行时把 JSON 解析为 NetworkPolicy。
 */

// ─── Network Policy Schema ────────────────────────────────

/**
 * 网络出口策略（与 EnvironmentDefinition.networkPolicyJson 对齐）。
 *
 * - allowEgress：总开关；false 表示全拒绝（默认）。
 * - allowDomains：允许的出站域名列表（支持通配符 *.example.com）。
 * - denyDomains：拒绝的域名列表（优先于 allowDomains）。
 * - allowPorts：允许的端口列表（空数组表示仅允许标准端口 80/443）。
 * - denyPorts：拒绝的端口列表（优先于 allowPorts）。
 * - allowPrivateNetwork：是否允许 RFC1918 私网地址（默认 false，防 SSRF）。
 * - allowLoopback：是否允许 loopback 127.0.0.1/::1（默认 false）。
 */
export interface NetworkPolicy {
 /** 总开关；false 表示全拒绝（fail-closed 默认值）。 */
 allowEgress: boolean;
 /** 允许的出站域名（支持前缀通配符 *.example.com）。 */
 allowDomains: readonly string[];
 /** 拒绝的域名（优先于 allowDomains）。 */
 denyDomains: readonly string[];
 /** 允许的端口列表；空数组表示仅允许 80/443。 */
 allowPorts: readonly number[];
 /** 拒绝的端口列表（优先于 allowPorts）。 */
 denyPorts: readonly number[];
 /** 是否允许 RFC1918 私网地址（10/8、172.16/12、192.168/16）；默认 false（防 SSRF）。 */
 allowPrivateNetwork: boolean;
 /** 是否允许 loopback 127.0.0.1/::1；默认 false。 */
 allowLoopback: boolean;
}

/** 默认 fail-closed 策略：全拒绝。 */
export const DEFAULT_NETWORK_POLICY: NetworkPolicy = {
 allowEgress: false,
 allowDomains: [],
 denyDomains: [],
 allowPorts: [],
 denyPorts: [],
 allowPrivateNetwork: false,
 allowLoopback: false,
};

/** 标准允许端口（allowPorts 为空时使用）。 */
export const STANDARD_ALLOWED_PORTS: readonly number[] = [80, 443];

// ─── 错误类型 ──────────────────────────────────────────────

/** 网络出口策略错误（route 层应映射为 422 EGRESS_BLOCKED）。 */
export class EgressPolicyError extends Error {
 constructor(
 public readonly code:
 | "egress_disabled"
 | "domain_denied"
 | "domain_not_allowed"
 | "port_denied"
 | "port_not_allowed"
 | "private_network_blocked"
 | "loopback_blocked"
 | "policy_invalid",
 message: string,
 ) {
 super(message);
 this.name = "EgressPolicyError";
 }
}

// ─── 解析与合并 ────────────────────────────────────────────

/**
 * 把 EnvironmentDefinition.networkPolicyJson（裸 JSON）解析为 NetworkPolicy。
 *
 * - 缺失字段使用 DEFAULT_NETWORK_POLICY 默认值（fail-closed）。
 * - 格式非法（非对象/字段类型错误）抛 EgressPolicyError(policy_invalid)。
 * - allowEgress 缺失视为 false（fail-closed）。
 */
export function parseNetworkPolicy(raw: unknown): NetworkPolicy {
 if (raw === null || raw === undefined) {
 return DEFAULT_NETWORK_POLICY;
 }
 if (typeof raw !== "object" || Array.isArray(raw)) {
 throw new EgressPolicyError("policy_invalid", "networkPolicyJson 非对象");
 }
 const obj = raw as Record<string, unknown>;

 const allowEgress = obj.allowEgress === true; // 严格布尔，缺省/false/其他 → false
 const allowDomains = parseStringArray(obj.allowDomains, "allowDomains");
 const denyDomains = parseStringArray(obj.denyDomains, "denyDomains");
 const allowPorts = parseNumberArray(obj.allowPorts, "allowPorts");
 const denyPorts = parseNumberArray(obj.denyPorts, "denyPorts");
 const allowPrivateNetwork = obj.allowPrivateNetwork === true;
 const allowLoopback = obj.allowLoopback === true;

 return {
 allowEgress,
 allowDomains,
 denyDomains,
 allowPorts,
 denyPorts,
 allowPrivateNetwork,
 allowLoopback,
 };
}

/**
 * 合并多个 NetworkPolicy：优先级从高到低，deny 永远合并（取并集），allow 取最严格。
 *
 * 优先级（高 → 低）：environment > tenant > agent。
 * - allowEgress：任一 false → false（最严格）。
 * - allowDomains：取交集（仅都允许的域名才允许）。
 * - denyDomains：取并集（任一拒绝即拒绝）。
 * - allowPorts：取交集。
 * - denyPorts：取并集。
 * - allowPrivateNetwork/allowLoopback：任一 false → false。
 */
export function mergeNetworkPolicies(policies: readonly NetworkPolicy[]): NetworkPolicy {
 if (policies.length === 0) return DEFAULT_NETWORK_POLICY;
 if (policies.length === 1) {
 const single = policies[0];
 return single ?? DEFAULT_NETWORK_POLICY;
 }

 const first = policies[0];
 if (!first) return DEFAULT_NETWORK_POLICY;
 let allowEgress = true;
 let allowDomains = first.allowDomains;
 let denyDomains: string[] = [...first.denyDomains];
 let allowPorts = first.allowPorts;
 let denyPorts: number[] = [...first.denyPorts];
 let allowPrivateNetwork = true;
 let allowLoopback = true;

 for (const p of policies) {
 if (!p.allowEgress) allowEgress = false;
 allowDomains = intersectStrings(allowDomains, p.allowDomains);
 denyDomains = unionStrings(denyDomains, p.denyDomains);
 allowPorts = intersectNumbers(allowPorts, p.allowPorts);
 denyPorts = unionNumbers(denyPorts, p.denyPorts);
 if (!p.allowPrivateNetwork) allowPrivateNetwork = false;
 if (!p.allowLoopback) allowLoopback = false;
 }

 return {
 allowEgress,
 allowDomains,
 denyDomains,
 allowPorts,
 denyPorts,
 allowPrivateNetwork,
 allowLoopback,
 };
}

/**
 * 解析最终生效的 Egress Policy：按 environment → tenant → agent 顺序合并。
 *
 * 调用方传入各层级 policy（任意可空，空表示该层级无策略）。
 * 任一层级 allowEgress=false 即整体拒绝。
 */
export function resolveEgressPolicy(params: {
 environmentPolicy?: NetworkPolicy | null;
 tenantPolicy?: NetworkPolicy | null;
 agentPolicy?: NetworkPolicy | null;
}): NetworkPolicy {
 const layers: NetworkPolicy[] = [];
 if (params.environmentPolicy) layers.push(params.environmentPolicy);
 if (params.tenantPolicy) layers.push(params.tenantPolicy);
 if (params.agentPolicy) layers.push(params.agentPolicy);
 return mergeNetworkPolicies(layers);
}

// ─── 校验 ──────────────────────────────────────────────────

/**
 * 校验目标 host 是否允许出站。
 *
 * - allowEgress=false → 拒绝（egress_disabled）。
 * - host 命中 denyDomains → 拒绝（domain_denied）。
 * - host 未命中 allowDomains（且 allowDomains 非空）→ 拒绝（domain_not_allowed）。
 * - allowDomains 为空 → 拒绝（domain_not_allowed，fail-closed）。
 * - 私网地址且 allowPrivateNetwork=false → 拒绝。
 * - loopback 且 allowLoopback=false → 拒绝。
 *
 * @throws EgressPolicyError 拒绝时抛错
 */
export function assertEgressAllowed(policy: NetworkPolicy, host: string, port?: number): void {
 if (!policy.allowEgress) {
 throw new EgressPolicyError("egress_disabled", "网络出口总开关关闭（fail-closed）");
 }

 const normalizedHost = host.toLowerCase().trim();

 // 1. denyDomains 优先
 for (const deny of policy.denyDomains) {
 if (matchDomain(normalizedHost, deny.toLowerCase())) {
 throw new EgressPolicyError("domain_denied", `域名 ${normalizedHost} 命中 deny 列表 ${deny}`);
 }
 }

 // 2. 私网地址（优先于 allowDomains，防 SSRF：即使 allowDomains 包含私网地址也阻止）
 if (isPrivateNetwork(normalizedHost) && !policy.allowPrivateNetwork) {
 throw new EgressPolicyError(
 "private_network_blocked",
 `私网地址 ${normalizedHost} 被阻止（防 SSRF）`,
 );
 }

 // 3. loopback（优先于 allowDomains，同理）
 if (isLoopback(normalizedHost) && !policy.allowLoopback) {
 throw new EgressPolicyError("loopback_blocked", `loopback 地址 ${normalizedHost} 被阻止`);
 }

 // 4. allowDomains（空数组表示全拒绝）
 if (policy.allowDomains.length === 0) {
 throw new EgressPolicyError(
 "domain_not_allowed",
 `域名 ${normalizedHost} 不在 allow 列表（空 allowlist 全拒绝）`,
 );
 }
 const allowed = policy.allowDomains.some((d) => matchDomain(normalizedHost, d.toLowerCase()));
 if (!allowed) {
 throw new EgressPolicyError("domain_not_allowed", `域名 ${normalizedHost} 不在 allow 列表`);
 }

 // 5. 端口校验
 if (port !== undefined) {
 if (policy.denyPorts.includes(port)) {
 throw new EgressPolicyError("port_denied", `端口 ${port} 命中 deny 列表`);
 }
 const effectiveAllowPorts =
 policy.allowPorts.length > 0 ? policy.allowPorts : STANDARD_ALLOWED_PORTS;
 if (!effectiveAllowPorts.includes(port)) {
 throw new EgressPolicyError("port_not_allowed", `端口 ${port} 不在 allow 列表`);
 }
 }
}

/**
 * 校验 Tool 调用目标 URL 是否允许出站。
 *
 * 解析 URL 的 host 与 port，委托 assertEgressAllowed。
 * URL 解析失败直接拒绝（policy_invalid）。
 */
export function assertToolEgressAllowed(policy: NetworkPolicy, url: string): void {
 let parsed: URL;
 try {
 parsed = new URL(url);
 } catch {
 throw new EgressPolicyError("policy_invalid", `URL 解析失败: ${url}`);
 }

 const host = parsed.hostname;
 const portStr = parsed.port;
 const port = portStr ? Number.parseInt(portStr, 10) : defaultPortForProtocol(parsed.protocol);

 assertEgressAllowed(policy, host, port);
}

// ─── 内部辅助 ──────────────────────────────────────────────

function parseStringArray(value: unknown, fieldName: string): readonly string[] {
 if (value === undefined || value === null) return [];
 if (!Array.isArray(value)) {
 throw new EgressPolicyError("policy_invalid", `${fieldName} 非数组`);
 }
 for (const item of value) {
 if (typeof item !== "string") {
 throw new EgressPolicyError("policy_invalid", `${fieldName} 元素非字符串`);
 }
 }
 return value as string[];
}

function parseNumberArray(value: unknown, fieldName: string): readonly number[] {
 if (value === undefined || value === null) return [];
 if (!Array.isArray(value)) {
 throw new EgressPolicyError("policy_invalid", `${fieldName} 非数组`);
 }
 for (const item of value) {
 if (typeof item !== "number" || !Number.isFinite(item)) {
 throw new EgressPolicyError("policy_invalid", `${fieldName} 元素非有限数字`);
 }
 }
 return value as number[];
}

/**
 * 域名匹配：支持通配符前缀 *.example.com。
 * - 精确匹配：host === pattern
 * - 通配符匹配：host 以 .example.com 结尾（子域）或 host === example.com（根域）
 */
function matchDomain(host: string, pattern: string): boolean {
 if (pattern === host) return true;
 if (pattern.startsWith("*.")) {
 const base = pattern.slice(2);
 return host === base || host.endsWith(`.${base}`);
 }
 return false;
}

/** 判断是否为 RFC1918 私网地址或 IPv6 ULA。 */
function isPrivateNetwork(host: string): boolean {
 // IPv4 私网段
 if (/^10\.\d{1,3}\.\d{1,3}\.\d{1,3}$/.test(host)) return true;
 if (/^192\.168\.\d{1,3}\.\d{1,3}$/.test(host)) return true;
 if (/^172\.(1[6-9]|2\d|3[01])\.\d{1,3}\.\d{1,3}$/.test(host)) return true;
 // IPv6 ULA fc00::/7
 if (/^f[cd][0-9a-f]{2}:/.test(host)) return true;
 return false;
}

/** 判断是否为 loopback 127.0.0.1/8 或 ::1。 */
function isLoopback(host: string): boolean {
 if (/^127\.\d{1,3}\.\d{1,3}\.\d{1,3}$/.test(host)) return true;
 if (host === "::1") return true;
 if (host === "localhost") return true;
 return false;
}

function defaultPortForProtocol(protocol: string): number | undefined {
 switch (protocol) {
 case "http:":
 return 80;
 case "https:":
 return 443;
 case "ws:":
 return 80;
 case "wss:":
 return 443;
 default:
 return undefined;
 }
}

function intersectStrings(a: readonly string[], b: readonly string[]): readonly string[] {
 const setB = new Set(b);
 return a.filter((s) => setB.has(s));
}

function unionStrings(a: readonly string[], b: readonly string[]): string[] {
 const set = new Set(a);
 for (const s of b) set.add(s);
 return Array.from(set);
}

function intersectNumbers(a: readonly number[], b: readonly number[]): readonly number[] {
 const setB = new Set(b);
 return a.filter((n) => setB.has(n));
}

function unionNumbers(a: readonly number[], b: readonly number[]): number[] {
 const set = new Set(a);
 for (const n of b) set.add(n);
 return Array.from(set);
}
