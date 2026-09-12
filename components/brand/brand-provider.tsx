"use client";

import { apiFetch, apiPath } from "@/lib/api-fetch";
/**
 * BrandProvider：Web 侧品牌上下文。
 *
 * 服务端以初始快照注入（首屏零闪烁）；客户端订阅 /api/brand/stream 失效信号，
 * 收到后以 ETag 拉取 /api/brand 活更新（信号/状态分离）。断流不轮询，
 * 由 navigation/focus 场景的自然重渲染兜底（品牌极少变更）。
 */
import { DEFAULT_BRAND } from "@/lib/branding/brand-contract";
import { type BrandPresentation, toBrandPresentation } from "@/lib/branding/brand-presentation";
import { type ReactNode, createContext, useContext, useEffect, useRef, useState } from "react";

const BrandContext = createContext<BrandPresentation>(toBrandPresentation(DEFAULT_BRAND));

export function BrandProvider({
  initial,
  children,
}: {
  readonly initial?: BrandPresentation;
  readonly children: ReactNode;
}) {
  const [presentation, setPresentation] = useState<BrandPresentation>(
    initial ?? toBrandPresentation(DEFAULT_BRAND),
  );
  const etagRef = useRef<string | null>(null);

  useEffect(() => {
    let closed = false;

    const reload = async (): Promise<void> => {
      const headers: Record<string, string> = {};
      if (etagRef.current) headers["if-none-match"] = etagRef.current;
      const response = await apiFetch("/api/brand", { headers }).catch(() => null);
      if (!response || closed) return;
      if (response.status === 304) return;
      if (!response.ok) return;
      const nextEtag = response.headers.get("etag");
      const body = (await response.json().catch(() => null)) as {
        brand?: Parameters<typeof toBrandPresentation>[0];
      } | null;
      if (!body?.brand || closed) return;
      if (nextEtag) etagRef.current = nextEtag;
      setPresentation(toBrandPresentation(body.brand));
    };

    void reload();
    const source = new EventSource(apiPath("/api/brand/stream"));
    source.addEventListener("brand", () => {
      void reload();
    });
    return () => {
      closed = true;
      source.close();
    };
  }, []);

  return <BrandContext.Provider value={presentation}>{children}</BrandContext.Provider>;
}

export function useBrand(): BrandPresentation {
  return useContext(BrandContext);
}
