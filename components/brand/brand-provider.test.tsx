import { DEFAULT_BRAND } from "@/lib/branding/brand-contract";
import { act, cleanup, render, screen, waitFor } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
  vi.unstubAllEnvs();
  vi.resetModules();
});

describe("BrandProvider 子路径部署", () => {
  it("快照和失效订阅都使用应用 basePath，失效后携带 ETag 更新品牌", async () => {
    vi.stubEnv("NEXT_PUBLIC_SNOW_BASE_PATH", "/snowharness");
    vi.resetModules();
    const sources: Array<EventTarget & { url: string; close: ReturnType<typeof vi.fn> }> = [];
    vi.stubGlobal(
      "EventSource",
      class extends EventTarget {
        close = vi.fn();
        constructor(readonly url: string) {
          super();
          sources.push(this);
        }
      },
    );
    const fetch = vi.fn().mockResolvedValueOnce(
      new Response(JSON.stringify({ brand: { ...DEFAULT_BRAND, name: "测试工作台" } }), {
        headers: { etag: '"brand-1"' },
      }),
    );
    vi.stubGlobal("fetch", fetch);
    const { BrandProvider, useBrand } = await import("./brand-provider");
    function Consumer() {
      return <span>{useBrand().name}</span>;
    }
    const view = render(
      <BrandProvider>
        <Consumer />
      </BrandProvider>,
    );
    await screen.findByText("测试工作台");
    expect(fetch).toHaveBeenCalledWith("/snowharness/api/brand", { headers: {} });
    expect(sources[0]?.url).toBe("/snowharness/api/brand/stream");

    fetch.mockResolvedValueOnce(
      new Response(JSON.stringify({ brand: { ...DEFAULT_BRAND, name: "更新后的工作台" } }), {
        headers: { etag: '"brand-2"' },
      }),
    );
    act(() => sources[0]?.dispatchEvent(new Event("brand")));
    await screen.findByText("更新后的工作台");
    expect(fetch).toHaveBeenLastCalledWith("/snowharness/api/brand", {
      headers: { "if-none-match": '"brand-1"' },
    });

    fetch.mockResolvedValueOnce(new Response(null, { status: 304 }));
    act(() => sources[0]?.dispatchEvent(new Event("brand")));
    await waitFor(() => expect(fetch).toHaveBeenCalledTimes(3));
    expect(screen.getByText("更新后的工作台")).toBeTruthy();
    view.unmount();
    expect(sources[0]?.close).toHaveBeenCalledOnce();
  });
});
