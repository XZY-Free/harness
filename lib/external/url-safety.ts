/**
 * 外部 URL 安全守卫(/16/17 共用)。
 *
 * `classifyDomain` 只做域名 allowlist/blacklist 匹配,不挡协议与内网/元数据 IP。
 * 本模块补齐:
 * - 协议白名单:仅允许 http/https(挡 file:// / gopher:// / data:// 等)。
 * - 内网/元数据 IP:127./10./192.168./169.254./172.16-31./fc/fd/fe80/localhost/::1。
 * - DNS rebinding:`assertSafeExternalUrlResolved` 在字面量校验后做 DNS 解析,任一解析到
 * 内网/元数据 IP 即拒(挡域名解析到 169.254.169.254 等绕过)。
 *
 * 命中任一 → 视为不安全。供 webFetch rawFetch、MCP server URL、CI/CD webhook/status URL
 * 统一接入,防 SSRF 探测内网与云元数据端点(169.254.169.254)。
 */
import { resolve4, resolve6 } from "node:dns/promises";
import { isIP } from "node:net";

/** 内网 / 元数据地址 SSRF 防护:命中即拒绝。 */
export function isInternalHost(host: string): boolean {
 const h = host.toLowerCase();
 if (h === "localhost" || h === "::1") return true;
 // P2-9: IPv4-mapped IPv6 (::ffff:1.2.3.4) → 提取 IPv4 部分校验,防绕过
 const mapped = h.match(/^::ffff:(\d+\.\d+\.\d+\.\d+)$/);
 if (mapped && isInternalHost(mapped[1] as string)) return true;
 // P2-9: 十六进制 IP(0x7f000001 = 127.0.0.1)→ 潜在内网,拒
 if (/^0x[0-9a-f]+$/.test(h)) return true;
 if (
 h.startsWith("127.") ||
 h.startsWith("10.") ||
 h.startsWith("192.168.") ||
 h.startsWith("169.254.") ||
 h.startsWith("0.")
 ) {
 return true;
 }
 if (/^172\.(1[6-9]|2\d|3[01])\./.test(h)) return true;
 if (h.startsWith("fc") || h.startsWith("fd") || h.startsWith("fe80")) return true;
 return false;
}

/**
 * URL 是否安全:协议 http/https + host 非内网/元数据。
 * 非法 URL(无法解析)→ false。
 */
export function isSafeExternalUrl(url: string): boolean {
 let u: URL;
 try {
 u = new URL(url);
 } catch {
 return false;
 }
 if (u.protocol !== "http:" && u.protocol !== "https:") return false;
 const host = u.hostname;
 if (!host) return false;
 if (isInternalHost(host)) return false;
 return true;
}

/**
 * 断言外部 URL 安全,不安全抛 Error。供 rawFetch / MCP client / CI/CD fetch 入口调用。
 */
export function assertSafeExternalUrl(url: string, label = "url"): void {
 if (!isSafeExternalUrl(url)) {
 throw new Error(`${label} 不安全(协议非 http/https 或命中内网/元数据):${url}`);
 }
}

/**
 * 断言外部 URL 安全(含 DNS 解析后二次校验),供实际发起网络请求的入口调用。
 *
 * 在 `assertSafeExternalUrl`(协议 + host 字面量)基础上,对域名做 DNS 解析,
 * 任一解析到的 IP 命中内网/元数据 → 拒(防 DNS rebinding:域名解析到
 * 169.254.169.254 / 127.0.0.1 等绕过字面量校验)。
 *
 * - host 是 IP 字面量:已由 isSafeExternalUrl 覆盖,跳过解析。
 * - host 是域名:resolve4/resolve6 走系统 DNS(不读 /etc/hosts,防宿主 hosts 投毒)。
 * - DNS 解析失败(NXDOMAIN 等):不阻断,交由后续 fetch 自然失败。
 *
 * 残留:解析后到 fetch 间的 TOCTOU(rebinding)未完全堵,需解析→用解析 IP 直连+Host 头,
 * 当前 fetch/MCP SDK 不易注入直连 IP;本轮先收口主要风险。
 */
export async function assertSafeExternalUrlResolved(url: string, label = "url"): Promise<void> {
 assertSafeExternalUrl(url, label);
 const host = new URL(url).hostname;
 if (isIP(host) !== 0) return; // IP 字面量已由 isSafeExternalUrl 校验
 const [ipv4, ipv6] = await Promise.all([
 resolve4(host).catch(() => [] as string[]),
 resolve6(host).catch(() => [] as string[]),
 ]);
 for (const ip of [...ipv4, ...ipv6]) {
 if (isInternalHost(ip)) {
 throw new Error(`${label} 域名 ${host} 解析到内网/元数据 IP ${ip}(DNS rebinding):${url}`);
 }
 }
}

/**
 * Git remote URL 是否安全:支持 https://、git@host:path、ssh:// 三种合法形态,
 * 拒绝 file:// / gopher:// / data:// 等协议与内网/元数据 host。
 *
 * - https://user:token@host/path → new URL 解析(hostname 自动剥 userinfo),host 非内网即可。
 * - git@host:path(SCP 语法)→ 正则取 host 段校验。
 * - ssh://[user@]host[:port]/path → new URL 解析 ssh 协议,取 hostname 校验。
 * - file:// 与其它协议 → 直接拒绝。
 */
export function isSafeGitRemoteUrl(url: string): boolean {
 if (!url) return false;
 // SCP 语法:git@host:path(无协议头,首段含 @ 与结尾 :)
 const scp = url.match(/^[^@:]+@([^:/]+):/);
 if (scp) {
 const host = scp[1];
 return !!host && !isInternalHost(host);
 }
 // ssh:// 形式
 if (url.startsWith("ssh://")) {
 try {
 const u = new URL(url);
 const host = u.hostname;
 return !!host && !isInternalHost(host);
 } catch {
 return false;
 }
 }
 // http/https(含 userinfo 形式由 new URL 统一解析)
 return isSafeExternalUrl(url);
}

/**
 * 断言 git remote URL 安全,不安全抛 Error。供 deliverToGit 入口调用,
 * 防 owner 把工作区推到 file:/// 或内网/元数据端点(SSRF + 宿主文件系统写入)。
 */
export function assertSafeGitRemoteUrl(url: string, label = "git remote url"): void {
 if (!isSafeGitRemoteUrl(url)) {
 throw new Error(`${label} 不安全(协议非法或命中 file:///内网/元数据):${url}`);
 }
}
