"use client";
import { useRouter, useSearchParams } from "next/navigation";
import { useEffect } from "react";

/**
 * S1（12-P2-5）：analytics scope 持久化到 localStorage。
 * 挂载在 studio 总览页：无 query param scope 时读 localStorage 补全。
 */
export function ScopePersistence() {
  const router = useRouter();
  const sp = useSearchParams();
  useEffect(() => {
    const urlScope = sp.get("scope");
    if (!urlScope) {
      const saved = localStorage.getItem("snow-analytics-scope");
      if (saved === "global" || saved === "self") {
        router.replace(`/studio?scope=${saved}`);
      }
    } else {
      localStorage.setItem("snow-analytics-scope", urlScope);
    }
  }, [sp, router]);
  return null;
}
