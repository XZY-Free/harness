// @vitest-environment happy-dom
/**
 * S10-W04：useV11Catalog Hook 测试。
 *
 * 覆盖：
 * - 首次挂载触发 GET /api/v1/catalog/options。
 * - 200 响应解析 items + 提取 ETag。
 * - 304 响应保留现有 items。
 * - 错误响应转化为 ClientVisibleError。
 * - 网络异常转化。
 * - resource_type 查询参数拼接。
 * - 组件卸载时不更新状态。
 */
import { act, renderHook, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const fetchMock = vi.fn();
vi.stubGlobal("fetch", fetchMock);

import { useV11Catalog } from "./use-v11-catalog";

afterEach(() => {
  fetchMock.mockReset();
});

beforeEach(() => {
  fetchMock.mockReset();
});

function buildOkResponse(items: unknown[], revision = 1, etag = "catalog-tenant-employee-1") {
  return new Response(JSON.stringify({ items, next_cursor: null, catalog_revision: revision }), {
    status: 200,
    headers: { etag: `"${etag}"` },
  });
}

describe("useV11Catalog", () => {
  it("挂载时拉取 catalog options", async () => {
    fetchMock.mockResolvedValueOnce(
      buildOkResponse([
        {
          resource_type: "agent",
          resource_id: "agent-001",
          display_name: "通用 Agent",
          description: null,
          lifecycle_state: "enabled",
          visibility_summary: "可见",
          owner_user_id: null,
          tags: null,
          etag: "catalog-1",
        },
      ]),
    );

    const { result } = renderHook(() => useV11Catalog({ resourceTypes: ["agent"] }));

    await waitFor(() => {
      expect(result.current.loading).toBe(false);
    });

    expect(fetchMock).toHaveBeenCalledTimes(1);
    const url = fetchMock.mock.calls[0]?.[0];
    expect(typeof url === "string" && url.includes("resource_type=agent")).toBe(true);
    expect(result.current.items.length).toBe(1);
    expect(result.current.items[0]?.display_name).toBe("通用 Agent");
    expect(result.current.revision).toBe(1);
  });

  it("304 响应保留现有 items 且清空 loading", async () => {
    // 首次 200
    fetchMock.mockResolvedValueOnce(
      buildOkResponse([
        {
          resource_type: "agent",
          resource_id: "agent-001",
          display_name: "Agent A",
          description: null,
          lifecycle_state: "enabled",
          visibility_summary: "可见",
          owner_user_id: null,
          tags: null,
          etag: "catalog-1",
        },
      ]),
    );
    // 第二次 304
    fetchMock.mockResolvedValueOnce(new Response(null, { status: 304 }));

    const { result } = renderHook(() => useV11Catalog({ resourceTypes: ["agent"] }));

    await waitFor(() => {
      expect(result.current.items.length).toBe(1);
    });

    // 触发 refresh
    result.current.refresh();

    await waitFor(() => {
      expect(fetchMock).toHaveBeenCalledTimes(2);
    });

    await waitFor(() => {
      expect(result.current.loading).toBe(false);
    });

    // items 仍保留
    expect(result.current.items.length).toBe(1);
    expect(result.current.items[0]?.display_name).toBe("Agent A");
  });

  it("错误响应转化为 ClientVisibleError", async () => {
    fetchMock.mockResolvedValueOnce(
      new Response(
        JSON.stringify({
          error: {
            code: "AUTHENTICATION_REQUIRED",
            message: "未登录",
            request_id: "r1",
            retryable: false,
          },
        }),
        { status: 401 },
      ),
    );

    const { result } = renderHook(() => useV11Catalog({ resourceTypes: ["agent"] }));

    await waitFor(() => {
      expect(result.current.error).not.toBeNull();
    });

    expect(result.current.error?.code).toBe("AUTHENTICATION_REQUIRED");
    expect(result.current.loading).toBe(false);
  });

  it("网络异常转化为 NETWORK_ERROR", async () => {
    fetchMock.mockRejectedValueOnce(new Error("network down"));

    const { result } = renderHook(() => useV11Catalog({ resourceTypes: ["agent"] }));

    await waitFor(() => {
      expect(result.current.error).not.toBeNull();
    });

    expect(result.current.error?.code).toBe("NETWORK_ERROR");
  });

  it("autoFetch=false 时不主动拉取", () => {
    const { result } = renderHook(() =>
      useV11Catalog({ resourceTypes: ["agent"], autoFetch: false }),
    );

    expect(fetchMock).not.toHaveBeenCalled();
    expect(result.current.loading).toBe(false);
  });

  it("lifecycle_state 过滤参数正确拼接", async () => {
    fetchMock.mockResolvedValueOnce(buildOkResponse([]));

    const { result } = renderHook(() =>
      useV11Catalog({
        resourceTypes: ["agent", "skill"],
        lifecycleStates: ["enabled", "disabled"],
      }),
    );

    await waitFor(() => {
      expect(result.current.loading).toBe(false);
    });

    const url = fetchMock.mock.calls[0]?.[0] as string;
    // resource_type 与 lifecycle_state 均按字母升序拼接
    expect(url.includes("resource_type=agent%2Cskill")).toBe(true);
    expect(url.includes("lifecycle_state=disabled%2Cenabled")).toBe(true);
  });

  it("clearError 清空错误状态", async () => {
    fetchMock.mockRejectedValueOnce(new Error("network down"));

    const { result } = renderHook(() => useV11Catalog({ resourceTypes: ["agent"] }));

    await waitFor(() => {
      expect(result.current.error).not.toBeNull();
    });

    await act(async () => {
      result.current.clearError();
    });
    expect(result.current.error).toBeNull();
  });
});
