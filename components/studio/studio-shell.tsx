"use client";

/**
 * Studio 客户端外壳（消费方模型 v4 · 页面数据 API 化）。
 *
 * 取代原 server layout 的门禁与导航计算：挂载时拉取 /studio/api/context
 * （principal + 菜单可见性 + 权限快照 + auth-center 地址），分派四种状态：
 * - loading / redirecting：加载态；
 * - 401：跳转 /login?returnTo=当前地址（票据回跳后 middleware 兑换会话）；
 * - 403 / 503：无法访问门禁页（fail-closed）；
 * - ready：渲染导航 + 子页，并通过 React Context 下发快照供页面轻量断言。
 *
 * 安全边界：菜单与入口显隐只是 UX 层；一切数据与写操作的授权仍由服务端
 * API（requireStudioAction / requireActionScope）强制执行。
 */
import { StudioGatePage } from "@/components/studio/gate-page";
import { StudioNav } from "@/components/studio/nav";
import { StudioToastProvider } from "@/components/studio/toast-provider";
import { apiFetch, apiPath } from "@/lib/api-fetch";
import type { PermissionSnapshot } from "@/lib/identity-client/snapshot";
import type { StudioNavVisibility } from "@/lib/studio/nav-visibility";
import { type ReactNode, createContext, useContext, useEffect, useState } from "react";

/** /studio/api/context 成功响应体。 */
export interface StudioContextValue {
  readonly principal: {
    readonly id: string;
    readonly tenantId: string;
    readonly displayName: string | null;
    readonly email: string;
  };
  readonly nav: StudioNavVisibility;
  readonly snapshot: PermissionSnapshot;
  /** auth-center 基地址（企业跳转入口用；未配置为空串）。 */
  readonly authCenterBaseUrl: string;
}

const StudioContext = createContext<StudioContextValue | null>(null);

/** 读取 Studio 上下文（仅在 StudioShell ready 后的子页中可用）。 */
export function useStudioContext(): StudioContextValue {
  const value = useContext(StudioContext);
  if (!value) throw new Error("useStudioContext 必须在 StudioShell 内使用（studio 页层）");
  return value;
}

type ShellState =
  | { status: "loading" }
  | { status: "redirecting" }
  | { status: "denied"; message: string }
  | { status: "ready"; value: StudioContextValue };

export function StudioShell({ children }: { readonly children: ReactNode }) {
  const [state, setState] = useState<ShellState>({ status: "loading" });

  useEffect(() => {
    let active = true;
    void (async () => {
      try {
        const response = await apiFetch("/studio/api/context", { cache: "no-store" });
        if (!active) return;
        if (response.status === 401) {
          const returnTo = `${window.location.pathname}${window.location.search}`;
          window.location.replace(`${apiPath("/login")}?returnTo=${encodeURIComponent(returnTo)}`);
          setState({ status: "redirecting" });
          return;
        }
        const body = (await response.json().catch(() => null)) as {
          error?: { message?: string };
        } | null;
        if (!response.ok) {
          setState({
            status: "denied",
            message: body?.error?.message ?? "当前账号没有后台访问权限",
          });
          return;
        }
        setState({ status: "ready", value: body as StudioContextValue });
      } catch {
        if (!active) return;
        setState({ status: "denied", message: "身份服务暂不可用，请稍后重试" });
      }
    })();
    return () => {
      active = false;
    };
  }, []);

  if (state.status === "loading" || state.status === "redirecting") {
    return (
      <div className="flex min-h-dvh items-center justify-center text-sm text-muted-foreground">
        正在加载…
      </div>
    );
  }
  if (state.status === "denied") {
    return <StudioGatePage status={403} message={state.message} fullScreen />;
  }
  return (
    <StudioContext.Provider value={state.value}>
      <StudioToastProvider>
        <div className="flex h-dvh bg-background text-foreground">
          <StudioNav visibleItems={state.value.nav} />
          <main className="min-w-0 flex-1 overflow-y-auto px-5 pt-16 pb-10 md:px-10 md:py-10 lg:px-12">
            {children}
          </main>
        </div>
      </StudioToastProvider>
    </StudioContext.Provider>
  );
}
