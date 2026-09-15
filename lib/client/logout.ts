import { apiFetch } from "@/lib/api-fetch";

export async function logoutClientSession(options: {
  readonly cleanupDesktop?: () => Promise<void>;
  /** Desktop 在本地清理后，通过系统浏览器完成企业全局注销。 */
  readonly openExternal?: (url: string) => Promise<void>;
  readonly loginPath?: string;
  readonly navigate: (path: string) => void;
}): Promise<void> {
  const response = await apiFetch("/api/auth/logout", {
    method: "POST",
    credentials: "include",
  });
  if (!response.ok) throw new Error("退出失败，请重试");
  const result = await response.json();
  await options.cleanupDesktop?.();
  const external = safeExternalLogoutUrl(result.redirectTo);
  if (external && options.openExternal) {
    // 本地会话已经撤销；系统浏览器打开失败时仍回到本地登录页，不伪装成未退出。
    try {
      await options.openExternal(external);
    } catch {
      // 继续回到 Desktop 登录入口。
    }
  }
  options.navigate(
    external && !options.cleanupDesktop && !options.openExternal
      ? external
      : (options.loginPath ?? "/login"),
  );
}

function safeExternalLogoutUrl(value: unknown): string | null {
  if (typeof value !== "string") return null;
  try {
    const url = new URL(value);
    if (url.protocol !== "https:" || url.username || url.password) return null;
    return url.toString();
  } catch {
    return null;
  }
}
