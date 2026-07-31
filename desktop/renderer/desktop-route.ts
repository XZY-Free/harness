export type DesktopRoute =
  | { readonly kind: "home" }
  | { readonly kind: "new" }
  | { readonly kind: "thread"; readonly threadId: string }
  | { readonly kind: "not-found" };

const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export function parseDesktopRoute(pathname: string): DesktopRoute {
  if (pathname === "/" || pathname === "/desktop" || pathname === "/desktop/") {
    return { kind: "home" };
  }
  if (pathname === "/desktop/new") {
    return { kind: "new" };
  }
  const match = /^\/desktop\/chat\/([^/]+)$/.exec(pathname);
  if (match?.[1] && UUID_PATTERN.test(match[1])) {
    return { kind: "thread", threadId: match[1] };
  }
  return { kind: "not-found" };
}
