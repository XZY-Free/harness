import { describe, expect, it, vi } from "vitest";
import { BrandApplier } from "./applier";

function contract(name: string) {
  return {
    schemaVersion: 1,
    revision: 5,
    name,
    tagline: null,
    logo: { light: null, dark: null },
    icon: null,
    packaging: { productName: name, appId: "x", dockLabel: name },
    updatedAt: null,
    updatedBy: null,
  };
}

describe("BrandApplier", () => {
  it("200 时以 ETag 拉取并重设应用名/窗口标题/托盘提示", async () => {
    const fetchBrand = vi.fn(
      async (_url: string, _init?: RequestInit) =>
        new Response(JSON.stringify({ brand: contract("Acme") }), {
          status: 200,
          headers: { etag: '"5:0"' },
        }),
    );
    const setAppName = vi.fn();
    const setAllWindowTitles = vi.fn();
    const setTrayToolTip = vi.fn();
    const applier = new BrandApplier({
      baseUrl: "http://127.0.0.1:3100",
      fetchBrand,
      setAppName,
      setAllWindowTitles,
      setTrayToolTip,
    });

    await applier.refresh();

    expect(fetchBrand).toHaveBeenCalledWith("http://127.0.0.1:3100/api/brand", { headers: {} });
    expect(setAppName).toHaveBeenCalledWith("Acme");
    expect(setAllWindowTitles).toHaveBeenCalledWith("Acme");
    expect(setTrayToolTip).toHaveBeenCalledWith("Acme");
  });

  it("缓存 etag 后二次请求带 If-None-Match，304 不重设", async () => {
    const fetchBrand = vi
      .fn()
      .mockResolvedValueOnce(
        new Response(JSON.stringify({ brand: contract("Acme") }), {
          status: 200,
          headers: { etag: '"5:0"' },
        }),
      )
      .mockResolvedValueOnce(new Response(null, { status: 304 }));
    const setAppName = vi.fn();
    const applier = new BrandApplier({
      baseUrl: "http://127.0.0.1:3100",
      fetchBrand,
      setAppName,
      setAllWindowTitles: vi.fn(),
    });

    await applier.refresh();
    setAppName.mockClear();
    await applier.refresh();

    expect(fetchBrand.mock.calls[1]?.[1]).toEqual({ headers: { "if-none-match": '"5:0"' } });
    expect(setAppName).not.toHaveBeenCalled();
  });

  it("拉取失败保持现状不抛错", async () => {
    const fetchBrand = vi.fn(async () => new Response("boom", { status: 500 }));
    const setAppName = vi.fn();
    const applier = new BrandApplier({
      baseUrl: "http://127.0.0.1:3100",
      fetchBrand,
      setAppName,
      setAllWindowTitles: vi.fn(),
    });

    await expect(applier.refresh()).resolves.toBeUndefined();
    expect(setAppName).not.toHaveBeenCalled();
  });
});
