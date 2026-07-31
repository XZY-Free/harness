"use client";

/**
 * W3-6：基于 sonner 的 toast 系统。
 *
 * 保持原有 useToast() API（toast.error/success/info），底层接线 sonner。
 * 顶层挂载 ToastProvider 即可，消费端零改动。
 */

import { createContext, useContext, useMemo } from "react";
import { toast as sonnerToast, Toaster } from "sonner";

interface ToastApi {
  error: (message: string) => void;
  success: (message: string) => void;
  info: (message: string) => void;
}

const ToastContext = createContext<ToastApi | null>(null);

export function ToastProvider({ children }: { children: React.ReactNode }) {
  const api = useMemo<ToastApi>(
    () => ({
      error: (m) => sonnerToast.error(m),
      success: (m) => sonnerToast.success(m),
      info: (m) => sonnerToast.info(m),
    }),
    [],
  );

  return (
    <ToastContext.Provider value={api}>
      {children}
      <Toaster
        position="bottom-right"
        toastOptions={{
          classNames: {
            toast: "group toast",
          },
        }}
      />
    </ToastContext.Provider>
  );
}

/** 消费 toast API。必须在 ToastProvider 内调用。 */
export function useToast(): ToastApi {
  const ctx = useContext(ToastContext);
  if (!ctx) {
    // Provider 外调用：降级为 no-op + 控制台，避免崩溃（SSR / 测试环境）
    return {
      error: (m) => console.error("[toast] error:", m),
      success: (m) => console.info("[toast] success:", m),
      info: (m) => console.info("[toast] info:", m),
    };
  }
  return ctx;
}
