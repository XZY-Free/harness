import { useEffect, useState } from "react";

const NAVIGATION_EVENT = "snowharness:desktop:navigate";

function navigate(pathname: string, replace = false): void {
  if (!pathname.startsWith("/")) return;
  if (replace) history.replaceState(null, "", pathname);
  else history.pushState(null, "", pathname);
  window.dispatchEvent(new PopStateEvent("popstate"));
  window.dispatchEvent(new CustomEvent(NAVIGATION_EVENT));
}

export function usePathname(): string {
  const [pathname, setPathname] = useState(() => window.location.pathname);
  useEffect(() => {
    const update = () => setPathname(window.location.pathname);
    window.addEventListener("popstate", update);
    window.addEventListener(NAVIGATION_EVENT, update);
    return () => {
      window.removeEventListener("popstate", update);
      window.removeEventListener(NAVIGATION_EVENT, update);
    };
  }, []);
  return pathname;
}

export function useRouter(): { push(pathname: string): void; replace(pathname: string): void } {
  return {
    push: (pathname) => navigate(pathname),
    replace: (pathname) => navigate(pathname, true),
  };
}

export function navigateDesktop(pathname: string, replace = false): void {
  navigate(pathname, replace);
}
