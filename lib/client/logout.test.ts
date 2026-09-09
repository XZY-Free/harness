import { afterEach, describe, expect, it, vi } from "vitest";
import { logoutClientSession } from "./logout";

const apiFetch = vi.hoisted(() => vi.fn());
vi.mock("@/lib/api-fetch", () => ({ apiFetch }));

afterEach(() => vi.clearAllMocks());

describe("logoutClientSession", () => {
  it("先撤销服务端会话，再清理 Desktop 本地身份并跳转登录页", async () => {
    apiFetch.mockResolvedValue(new Response(JSON.stringify({ loggedOut: true })));
    const cleanupDesktop = vi.fn().mockResolvedValue(undefined);
    const navigate = vi.fn();

    await logoutClientSession({ cleanupDesktop, navigate });

    expect(apiFetch).toHaveBeenCalledWith("/api/auth/logout", {
      method: "POST",
      credentials: "include",
    });
    expect(cleanupDesktop).toHaveBeenCalledOnce();
    expect(navigate).toHaveBeenCalledWith("/login");
  });

  it("服务端撤销失败时不伪装成已退出", async () => {
    apiFetch.mockResolvedValue(new Response(null, { status: 503 }));
    const cleanupDesktop = vi.fn();
    const navigate = vi.fn();

    await expect(logoutClientSession({ cleanupDesktop, navigate })).rejects.toThrow("退出失败");
    expect(cleanupDesktop).not.toHaveBeenCalled();
    expect(navigate).not.toHaveBeenCalled();
  });

  it("Desktop 退出后回到本地渲染入口，由同一登录页接管", async () => {
    apiFetch.mockResolvedValue(new Response(JSON.stringify({ loggedOut: true })));
    const navigate = vi.fn();

    await logoutClientSession({ loginPath: "/desktop", navigate });

    expect(navigate).toHaveBeenCalledWith("/desktop");
  });
});
