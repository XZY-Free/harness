import { apiFetch } from "@/lib/api-fetch";

export async function logoutClientSession(options: {
  readonly cleanupDesktop?: () => Promise<void>;
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
  // Desktop 由本地身份清理和本地登录入口接管，不把远端页面装入应用渲染器。
  const external =
    !options.cleanupDesktop && typeof result.redirectTo === "string"
      ? new URL(result.redirectTo)
      : null;
  options.navigate(
    external?.protocol === "https:" && !external.username && !external.password
      ? external.toString()
      : (options.loginPath ?? "/login"),
  );
}
