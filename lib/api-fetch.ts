/**
 * 客户端 API 请求统一入口：自动拼接 Next.js basePath。
 *
 * 背景：部署到腾讯云时 next.config.ts 配置了 `basePath: "/snowharness"`（Nginx 子路径代理）。
 * Next.js 的 basePath 只自动作用于 <Link> / redirect() / 静态资源 URL，
 * **不会**作用于裸 fetch("/api/...")——请求会打到 Nginx 根路径，到不了 Next.js，
 * 返回非 JSON 404，前端兜底成误导性的"会话不存在"。
 *
 * 机制：basePath 通过 next.config.ts 的 `env.NEXT_PUBLIC_SNOW_BASE_PATH` 在构建时内联。
 * 未配置（本地开发 / vitest）时为空串，apiPath/apiFetch 为零开销恒等，
 * 测试中对 URL 字符串的断言无需修改。
 */

/** 构建时内联的 basePath（如 "/snowharness"），未设置时为空串。 */
const BASE_PATH = process.env.NEXT_PUBLIC_SNOW_BASE_PATH ?? "";

/**
 * 给应用内 API 路径拼 basePath 前缀。
 *
 * 防御规则：
 * - 仅处理 "/" 开头的同源路径；绝对 URL（http...）原样返回。
 * - 已带前缀的路径原样返回，避免双重拼接。
 */
export function apiPath(path: string): string {
 if (!BASE_PATH) return path;
 if (!path.startsWith("/")) return path;
 if (path === BASE_PATH || path.startsWith(`${BASE_PATH}/`)) return path;
 return `${BASE_PATH}${path}`;
}

/**
 * fetch 包装：自动拼 basePath。仅覆盖"字符串路径 + 可选 init"场景（本仓库全部用法）。
 * 返回值与签名和全局 fetch 保持一致，可直接替换裸 fetch 调用。
 */
export function apiFetch(path: string, init?: RequestInit): Promise<Response> {
 return fetch(apiPath(path), init);
}
