"use client";

import { ToastProvider } from "@/components/toast";

/**
 * studio 路由组的 ToastProvider client wrapper。
 *
 * studio/layout.tsx 是 server component（需做权限校验），不能直接挂 client ToastProvider。
 * 本 wrapper 让 server layout 能包一层 ToastProvider，使 studio 内的 useToast 有 UI。
 */
export function StudioToastProvider({ children }: { children: React.ReactNode }) {
  return <ToastProvider>{children}</ToastProvider>;
}
