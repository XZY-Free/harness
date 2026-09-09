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
  await options.cleanupDesktop?.();
  options.navigate(options.loginPath ?? "/login");
}
