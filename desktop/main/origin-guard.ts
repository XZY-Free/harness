/**
 * V10 Phase 3：Electron 主进程 origin 校验守卫（纯函数，可测试）。
 *
 * 拦截 BrowserWindow 内的外部导航与窗口打开，只允许受信任 Server origin 加载。
 * 防止 renderer 被诱导导航到恶意站点后绕过 sandbox / contextIsolation。
 *
 * 规则：
 * - 受信任 origin 列表从环境变量 SNOW_SERVER_ORIGIN 读取（逗号分隔），默认 http://localhost:3000。
 * - https://<domain> 在 allowedOrigins 中 → 允许。
 * - http://localhost:<port> / http://127.0.0.1:<port> 在 allowedOrigins 中 → 允许（本地开发）。
 * - 其他 http://（非 localhost / 127.0.0.1）→ 阻止（生产环境不允许非 localhost 的 http）。
 * - file://、data:、blob: → 阻止。
 * - about:blank → 允许（Electron 内部页面）。
 *
 * 本模块不依赖 electron，仅依赖 Node/URL 全局，便于单测。
 */

/** 默认受信任 Server origin（本地开发）。 */
export const DEFAULT_SERVER_ORIGIN = "http://localhost:3000";

/**
 * 获取 URL 的 origin。
 * 无效 URL 返回 null。about:blank 返回 "about:blank" 哨兵值。
 * file://、data:、blob: 等非 http(s) 协议返回 null（origin 不可信）。
 */
export function getOrigin(url: string): string | null {
  if (!url || url.length === 0) {
    return null;
  }
  // about:blank 特殊处理：Electron 内部页面，允许加载，返回哨兵值
  if (url === "about:blank") {
    return "about:blank";
  }
  try {
    const u = new URL(url);
    // 只对 http/https 返回 origin，其他协议（file/data/blob 等）origin 不可信
    if (u.protocol !== "http:" && u.protocol !== "https:") {
      return null;
    }
    return u.origin;
  } catch {
    return null;
  }
}

/**
 * 判断 origin 是否符合协议规则：
 * - https 任意 host 均可（生产环境）。
 * - http 仅允许 localhost / 127.0.0.1（本地开发）。
 * - http 任意 host（仅当 allowInsecureRemote=true，连接远程 http 部署时显式开启）。
 */
function isEligibleOrigin(origin: string, allowInsecureRemote = false): boolean {
  try {
    const u = new URL(origin);
    if (u.protocol === "https:") {
      return true;
    }
    if (u.protocol === "http:") {
      if (u.hostname === "localhost" || u.hostname === "127.0.0.1") {
        return true;
      }
      // 显式 opt-in 放行公网 http（如连接远程 http 部署的服务器）
      return allowInsecureRemote;
    }
    return false;
  } catch {
    return false;
  }
}

/**
 * 从可能含 basePath 的条目提取纯 origin。
 * 如 "http://119.45.222.120/snowharness" → "http://119.45.222.120"。
 * 无效条目返回 null。
 */
function extractOriginFromEntry(entry: string): string | null {
  return getOrigin(entry);
}

/**
 * 检查 URL 是否为受信任 Server origin。
 * 需要 origin 在 allowedOrigins 列表中，且符合协议规则。
 * about:blank 不是 server origin，返回 false。
 *
 * allowedOrigins 条目可含 basePath（如 http://host/snowharness），比对时提取 origin。
 * allowInsecureRemote 从环境变量 SNOW_ALLOW_INSECURE_REMOTE_ORIGIN 读取（主进程侧）。
 */
export function isTrustedServerOrigin(
  url: string,
  allowedOrigins: readonly string[],
  allowInsecureRemote = false,
): boolean {
  const origin = getOrigin(url);
  if (origin === null) {
    return false;
  }
  // about:blank 哨兵值不是 server origin
  if (origin === "about:blank") {
    return false;
  }
  // allowedOrigins 条目可能含 basePath，提取 origin 比对
  const allowedOriginSet = new Set(
    allowedOrigins
      .map((o) => extractOriginFromEntry(o))
      .filter((o): o is string => o !== null),
  );
  if (!allowedOriginSet.has(origin)) {
    return false;
  }
  return isEligibleOrigin(origin, allowInsecureRemote);
}

/**
 * 拦截外部导航——判断导航目标是否应该被阻止在 BrowserWindow 内加载。
 * 返回 true 表示应阻止，false 表示允许。
 *
 * - 空字符串 / 无效 URL → 阻止。
 * - file://、data:、blob: 等非 http(s) 协议 → 阻止。
 * - about:blank → 允许（Electron 内部页面）。
 * - 受信任 Server origin → 允许；其余 → 阻止。
 *
 * allowInsecureRemote 透传给 isTrustedServerOrigin（默认从 env 读取）。
 */
export function shouldBlockNavigation(
  targetUrl: string,
  allowedOrigins: readonly string[],
  allowInsecureRemote = false,
): boolean {
  if (!targetUrl || targetUrl.length === 0) {
    return true;
  }
  // about:blank 允许（Electron 内部页面）
  if (targetUrl === "about:blank") {
    return false;
  }
  let u: URL;
  try {
    u = new URL(targetUrl);
  } catch {
    // 无效 URL 阻止
    return true;
  }
  // file://、data:、blob: 等非 http(s) 协议阻止
  if (u.protocol !== "http:" && u.protocol !== "https:") {
    return true;
  }
  // 只允许受信任 Server origin
  return !isTrustedServerOrigin(targetUrl, allowedOrigins, allowInsecureRemote);
}

/**
 * 从环境变量读取受信任 Server origin 列表。
 * 逗号分隔，默认 http://localhost:3000。空值或全空白时回退默认值。
 *
 * 默认参数使用 process.env，便于在主进程中直接调用；
 * 单测可传入自定义 env 对象，避免污染全局环境。
 */
export function loadAllowedOrigins(env: NodeJS.ProcessEnv = process.env): string[] {
  const raw = env.SNOW_SERVER_ORIGIN;
  if (!raw || raw.trim().length === 0) {
    return [DEFAULT_SERVER_ORIGIN];
  }
  const origins = raw
    .split(",")
    .map((s) => s.trim())
    .filter((s) => s.length > 0);
  if (origins.length === 0) {
    return [DEFAULT_SERVER_ORIGIN];
  }
  return origins;
}
