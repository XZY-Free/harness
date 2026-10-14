"use client";

import { apiFetch } from "@/lib/api-fetch";
/**
 * 轻量 JSON API 数据钩子（Studio 页面数据 API 化）。
 *
 * 语义：
 * - 挂载 / path 变更时发起一次 GET（cache: no-store；cookie 会话直通）。
 * - 兼容两类成功信封：apiSuccess（裸资源）与旧 jsonOk（{ ok, data }）。
 * - 失败保留 HTTP 状态与错误消息（供页面区分 401/403/404/500）。
 * - reload() 触发一次重取；组件卸载后丢弃在途结果。
 */
import { useCallback, useEffect, useState } from "react";

export interface ApiDataState<T> {
  readonly data: T | null;
  readonly loading: boolean;
  /** 非 2xx 时的 HTTP 状态；网络失败为 0；成功为 null。 */
  readonly httpStatus: number | null;
  readonly errorMessage: string | null;
  readonly reload: () => void;
}

export function useApiData<T>(path: string): ApiDataState<T> {
  const [data, setData] = useState<T | null>(null);
  const [loading, setLoading] = useState(true);
  const [httpStatus, setHttpStatus] = useState<number | null>(null);
  const [errorMessage, setErrorMessage] = useState<string | null>(null);
  const [version, setVersion] = useState(0);

  const reload = useCallback(() => setVersion((v) => v + 1), []);

  // biome-ignore lint/correctness/useExhaustiveDependencies: version 是手动重取信号（reload() 递增触发），非直接引用
  useEffect(() => {
    let active = true;
    setLoading(true);
    setHttpStatus(null);
    setErrorMessage(null);
    void (async () => {
      try {
        const response = await apiFetch(path, { cache: "no-store" });
        const body = (await response.json().catch(() => null)) as unknown;
        if (!active) return;
        if (!response.ok) {
          setHttpStatus(response.status);
          setErrorMessage(extractErrorMessage(body) ?? `请求失败（HTTP ${response.status}）`);
          setData(null);
          return;
        }
        setData(unwrapEnvelope(body) as T);
      } catch {
        if (!active) return;
        setHttpStatus(0);
        setErrorMessage("网络请求失败，请检查连接后重试");
        setData(null);
      } finally {
        if (active) setLoading(false);
      }
    })();
    return () => {
      active = false;
    };
  }, [path, version]);

  return { data, loading, httpStatus, errorMessage, reload };
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null;
}

/** 旧 jsonOk 信封（{ ok: true, data }）解包；apiSuccess 裸资源原样返回。 */
function unwrapEnvelope(body: unknown): unknown {
  if (isRecord(body) && body.ok === true && "data" in body) return body.data;
  return body;
}

function extractErrorMessage(body: unknown): string | null {
  if (isRecord(body) && isRecord(body.error) && typeof body.error.message === "string") {
    return body.error.message;
  }
  return null;
}
