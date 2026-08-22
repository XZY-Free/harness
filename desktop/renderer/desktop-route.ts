// 专题01 §33.7：Desktop 产品入口为 /desktop（新建空态）与 /desktop/chat/{threadId}。
// 假 new 路由 /desktop/new 已移除；/desktop 恒为新建空态页（不再自动跳最近会话）。
export type DesktopRoute =
  | { readonly kind: "home" }
  | { readonly kind: "thread"; readonly threadId: string }
  | { readonly kind: "not-found" };

const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export function parseDesktopRoute(pathname: string): DesktopRoute {
  if (pathname === "/" || pathname === "/desktop" || pathname === "/desktop/") {
    return { kind: "home" };
  }
  const match = /^\/desktop\/chat\/([^/]+)$/.exec(pathname);
  if (match?.[1] && UUID_PATTERN.test(match[1])) {
    return { kind: "thread", threadId: match[1] };
  }
  return { kind: "not-found" };
}
