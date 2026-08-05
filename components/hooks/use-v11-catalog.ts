/**
 * V11 员工端 Catalog Hook（S10-W04）。
 *
 * 事实源：
 * - docs/solutions/v11-agentkit-platform/12-capability-and-collaboration-api.md §2（Employee Catalog API）
 * - docs/solutions/v11-agentkit-platform-development-plan/10-employee-web-and-desktop-experience.md
 *   S10-W04：「Agent、模型、Skill 与位置选择」
 *
 * 职责：
 * - 调用 GET /api/v1/catalog/options 拉取目录条目（按 resource_type 过滤）。
 * - 实现 If-None-Match 客户端缓存：首次拉取后记录 ETag，后续请求带 If-None-Match；
 *   服务端返回 304 时不更新数据，仅清空 loading。
 * - 维护 loading / error 状态，供 UI 显示。
 * - 错误转化为 ClientVisibleError。
 *
 * 不变量：
 * - 同一 resourceTypes 字符串相同时不重复并发拉取（通过 ref 守卫）。
 * - 组件卸载时丢弃 in-flight 响应（avoid setState on unmounted）。
 * - ETag 来自响应头 ETag（catalog-{tenantId}-employee-{revision}）。
 *
 * 使用：
 * ```tsx
 * const { items, loading, error, refresh } = useV11Catalog({ resourceTypes: ["agent"] });
 * ```
 */
"use client";

import { apiFetch } from "@/lib/api-fetch";
import { toVisibleError } from "@/lib/v11/client/error-messages";
import type {
  ClientCatalogItem,
  ClientCatalogListResponse,
  ClientCatalogResourceType,
  ClientErrorBody,
  ClientVisibleError,
} from "@/lib/v11/client/types";
import { useCallback, useEffect, useRef, useState } from "react";

/** Hook 入参。 */
interface UseV11CatalogParams {
  /** 资源类型过滤；不传则返回全部类型。 */
  readonly resourceTypes?: readonly ClientCatalogResourceType[];
  /** lifecycle 状态过滤；默认 ["enabled"]。 */
  readonly lifecycleStates?: readonly string[];
  /** 是否自动拉取；默认 true。组件挂载时拉取一次。 */
  readonly autoFetch?: boolean;
}

/** Hook 返回值。 */
export interface UseV11CatalogResult {
  /** 目录条目（按 resource_type / display_name 排序稳定）。 */
  readonly items: readonly ClientCatalogItem[];
  /** 是否正在拉取（首次或 refresh）。 */
  readonly loading: boolean;
  /** 错误。 */
  readonly error: ClientVisibleError | null;
  /** 当前缓存的 catalogRevision；null 表示尚未拉取过。 */
  readonly revision: number | null;
  /** 手动刷新（强制带 If-None-Match；304 视为未变化）。 */
  readonly refresh: () => void;
  /** 清除错误。 */
  readonly clearError: () => void;
}

/** 把 resourceTypes 数组转为稳定 query 参数（按字母升序）。 */
function stableResourceTypesParam(types?: readonly ClientCatalogResourceType[]): string {
  if (!types || types.length === 0) return "";
  return [...types].sort().join(",");
}

function stableLifecycleStatesParam(states?: readonly string[]): string {
  if (!states || states.length === 0) return "";
  return [...states].sort().join(",");
}

/** 解析错误响应为可见错误。 */
async function parseError(response: Response): Promise<ClientVisibleError> {
  const bodyText = await response.text().catch(() => "");
  let errorBody: ClientErrorBody | null = null;
  try {
    errorBody = JSON.parse(bodyText) as ClientErrorBody;
  } catch {
    // ignore
  }
  if (errorBody) return toVisibleError(errorBody);
  return {
    code: "NETWORK_ERROR",
    title: "网络异常",
    description: "无法连接服务器，请检查网络后再试。",
    retryable: true,
    recoveryAction: "reload_page",
    requestId: null,
  };
}

/** V11 Catalog Hook。 */
export function useV11Catalog({
  resourceTypes,
  lifecycleStates,
  autoFetch = true,
}: UseV11CatalogParams = {}): UseV11CatalogResult {
  const [items, setItems] = useState<readonly ClientCatalogItem[]>([]);
  const [loading, setLoading] = useState<boolean>(autoFetch);
  const [error, setError] = useState<ClientVisibleError | null>(null);
  const [revision, setRevision] = useState<number | null>(null);

  // 客户端缓存的 ETag；同 resourceTypes + lifecycleStates 组合下复用。
  const etagRef = useRef<string | null>(null);
  // in-flight 守卫：避免并发拉取同一组参数。
  const inflightRef = useRef<boolean>(false);
  // 组件卸载标志。
  const unmountedRef = useRef<boolean>(false);

  const rtKey = stableResourceTypesParam(resourceTypes);
  const lsKey = stableLifecycleStatesParam(lifecycleStates ?? ["enabled"]);

  const doFetch = useCallback(async () => {
    if (inflightRef.current) return;
    if (unmountedRef.current) return;
    inflightRef.current = true;
    setLoading(true);
    setError(null);
    try {
      const params = new URLSearchParams();
      if (rtKey) params.set("resource_type", rtKey);
      if (lsKey) params.set("lifecycle_state", lsKey);
      const query = params.toString();
      const url = `/api/v1/catalog/options${query ? `?${query}` : ""}`;
      const headers: Record<string, string> = {};
      if (etagRef.current) {
        headers["if-none-match"] = `"${etagRef.current}"`;
      }
      const resp = await apiFetch(url, {
        method: "GET",
        credentials: "include",
        headers,
      });
      if (resp.status === 304) {
        // 目录未变化，保留现有 items
        return;
      }
      if (!resp.ok) {
        const visible = await parseError(resp);
        if (!unmountedRef.current) setError(visible);
        return;
      }
      const data = (await resp.json()) as ClientCatalogListResponse;
      // 提取 ETag（去引号）
      const etagHeader = resp.headers.get("etag") ?? resp.headers.get("ETag");
      const rawEtag = etagHeader ? etagHeader.replace(/^W\//, "").replace(/^"|"$/g, "") : null;
      if (rawEtag) etagRef.current = rawEtag;
      if (!unmountedRef.current) {
        setItems(data.items);
        setRevision(data.catalog_revision);
      }
    } catch {
      if (!unmountedRef.current) {
        setError({
          code: "NETWORK_ERROR",
          title: "网络异常",
          description: "无法连接服务器，请检查网络后再试。",
          retryable: true,
          recoveryAction: "reload_page",
          requestId: null,
        });
      }
    } finally {
      if (!unmountedRef.current) setLoading(false);
      inflightRef.current = false;
    }
  }, [rtKey, lsKey]);

  useEffect(() => {
    unmountedRef.current = false;
    if (autoFetch) {
      void doFetch();
    }
    return () => {
      unmountedRef.current = true;
    };
  }, [doFetch, autoFetch]);

  const refresh = useCallback(() => {
    void doFetch();
  }, [doFetch]);

  const clearError = useCallback(() => setError(null), []);

  return {
    items,
    loading,
    error,
    revision,
    refresh,
    clearError,
  };
}
