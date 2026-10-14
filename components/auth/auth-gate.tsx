"use client";

import { apiFetch, apiPath } from "@/lib/api-fetch";
/**
 * 使用端登录门禁（客户端）。
 *
 * /chat 页外壳用：挂载时校验会话（GET /api/user/current）；
 * 未登录（401）跳转统一登录入口 /login（auth-center 302 壳 + 票据回跳），
 * 已登录渲染子内容。取代原 server 侧 requireAuthenticatedPage。
 */
import { type ReactNode, useEffect, useState } from "react";

export function AuthGate({
  returnTo,
  children,
}: {
  readonly returnTo: string;
  readonly children: ReactNode;
}) {
  const [status, setStatus] = useState<"loading" | "redirecting" | "ok" | "error">("loading");

  useEffect(() => {
    let active = true;
    void (async () => {
      try {
        const response = await apiFetch("/api/user/current", { cache: "no-store" });
        if (!active) return;
        if (response.ok) {
          setStatus("ok");
          return;
        }
        if (response.status === 401) {
          window.location.replace(`${apiPath("/login")}?returnTo=${encodeURIComponent(returnTo)}`);
          setStatus("redirecting");
          return;
        }
        setStatus("error");
      } catch {
        if (active) setStatus("error");
      }
    })();
    return () => {
      active = false;
    };
  }, [returnTo]);

  if (status === "ok") return <>{children}</>;
  return (
    <div className="flex min-h-dvh items-center justify-center text-sm text-muted-foreground">
      {status === "error" ? "加载失败，请刷新重试" : "正在加载…"}
    </div>
  );
}
