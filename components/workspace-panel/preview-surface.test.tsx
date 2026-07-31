import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

// Mock fetch 用于 restart AppRuntime
const mockFetch = vi.fn();
global.fetch = mockFetch as unknown as typeof fetch;

import { PreviewSurface } from "./preview-surface";

afterEach(() => {
  cleanup();
  mockFetch.mockReset();
});

beforeEach(() => {
  mockFetch.mockReset();
});

describe("PreviewSurface (V10 Phase 1)", () => {
  describe("基础渲染", () => {
    it("previewUrl 存在时渲染 iframe 加载 /preview/{threadId}/...", () => {
      render(<PreviewSurface threadId="t1" previewUrl="/preview/t1/index.html" reloadKey={0} />);
      const iframe = screen.getByTitle("项目预览") as HTMLIFrameElement;
      expect(iframe).toBeTruthy();
      expect(iframe.src).toContain("/preview/t1/index.html");
      // iframe sandbox 必须包含 allow-scripts allow-same-origin
      expect(iframe.getAttribute("sandbox")).toContain("allow-scripts");
      expect(iframe.getAttribute("sandbox")).toContain("allow-same-origin");
    });

    it("previewUrl=null 时显示 idle 占位（项目尚未启动）", () => {
      render(<PreviewSurface threadId="t1" previewUrl={null} reloadKey={0} />);
      expect(screen.getByText("项目尚未启动")).toBeTruthy();
      expect(screen.queryByTitle("项目预览")).toBeNull();
    });
  });

  describe("工具栏", () => {
    it("包含后退、前进、刷新、重启 AppRuntime、新窗口按钮", () => {
      render(<PreviewSurface threadId="t1" previewUrl="/preview/t1/index.html" reloadKey={0} />);
      expect(screen.getByLabelText("后退")).toBeTruthy();
      expect(screen.getByLabelText("前进")).toBeTruthy();
      expect(screen.getByLabelText("刷新")).toBeTruthy();
      expect(screen.getByLabelText("重启 AppRuntime")).toBeTruthy();
      expect(screen.getByLabelText("新窗口打开")).toBeTruthy();
    });

    it("包含项目 URL 只读输入框显示当前 previewUrl", () => {
      render(<PreviewSurface threadId="t1" previewUrl="/preview/t1/index.html" reloadKey={0} />);
      const urlInput = screen.getByDisplayValue("/preview/t1/index.html") as HTMLInputElement;
      expect(urlInput).toBeTruthy();
      expect(urlInput.readOnly).toBe(true);
    });

    it("包含设备尺寸选择器（响应式/桌面/平板/手机）", () => {
      render(<PreviewSurface threadId="t1" previewUrl="/preview/t1/index.html" reloadKey={0} />);
      expect(screen.getByLabelText("响应式")).toBeTruthy();
      expect(screen.getByLabelText("桌面")).toBeTruthy();
      expect(screen.getByLabelText("平板")).toBeTruthy();
      expect(screen.getByLabelText("手机")).toBeTruthy();
    });
  });

  describe("刷新", () => {
    it("点击刷新按钮递增 iframe reloadKey（通过 key 变化重载 iframe）", () => {
      const { rerender } = render(
        <PreviewSurface threadId="t1" previewUrl="/preview/t1/index.html" reloadKey={0} />,
      );
      const iframeBefore = screen.getByTitle("项目预览") as HTMLIFrameElement;
      const srcBefore = iframeBefore.src;

      // 点击刷新
      fireEvent.click(screen.getByLabelText("刷新"));

      const iframeAfter = screen.getByTitle("项目预览") as HTMLIFrameElement;
      // src 应该保持不变（刷新不是导航）
      expect(iframeAfter.src).toBe(srcBefore);
      // 但 iframe key 应该变了（通过重新挂载）
      expect(iframeAfter).not.toBe(iframeBefore);
    });
  });

  describe("重启 AppRuntime", () => {
    it("点击重启按钮调用 POST /api/threads/{id}/runtime/restart", async () => {
      mockFetch.mockResolvedValueOnce({
        ok: true,
        json: async () => ({ ok: true }),
      } as Response);

      render(<PreviewSurface threadId="t1" previewUrl="/preview/t1/index.html" reloadKey={0} />);
      fireEvent.click(screen.getByLabelText("重启 AppRuntime"));

      await vi.waitFor(() => {
        expect(mockFetch).toHaveBeenCalledWith(
          "/api/threads/t1/runtime/restart",
          expect.objectContaining({ method: "POST" }),
        );
      });
    });

    it("重启中显示 restarting 状态", async () => {
      // 让 fetch 永远 pending
      mockFetch.mockReturnValueOnce(new Promise(() => {}));

      render(<PreviewSurface threadId="t1" previewUrl="/preview/t1/index.html" reloadKey={0} />);
      fireEvent.click(screen.getByLabelText("重启 AppRuntime"));

      await vi.waitFor(() => {
        expect(screen.getByText("重启中")).toBeTruthy();
      });
    });

    it("重启失败显示错误状态", async () => {
      mockFetch.mockResolvedValueOnce({
        ok: false,
        json: async () => ({ error: { message: "重启失败" } }),
      } as Response);

      render(<PreviewSurface threadId="t1" previewUrl="/preview/t1/index.html" reloadKey={0} />);
      fireEvent.click(screen.getByLabelText("重启 AppRuntime"));

      await vi.waitFor(() => {
        expect(screen.getByText(/重启失败/)).toBeTruthy();
      });
    });
  });

  describe("新窗口打开", () => {
    it("点击新窗口按钮调用 window.open 打开 previewUrl", () => {
      const openSpy = vi.spyOn(window, "open").mockReturnValue(null);
      render(<PreviewSurface threadId="t1" previewUrl="/preview/t1/index.html" reloadKey={0} />);
      fireEvent.click(screen.getByLabelText("新窗口打开"));
      expect(openSpy).toHaveBeenCalledWith("/preview/t1/index.html", "_blank", "noopener");
      openSpy.mockRestore();
    });
  });

  describe("设备尺寸", () => {
    it("默认响应式（iframe 占满容器宽度）", () => {
      render(<PreviewSurface threadId="t1" previewUrl="/preview/t1/index.html" reloadKey={0} />);
      const container = screen.getByTestId("preview-iframe-container");
      // 响应式：容器无固定宽度约束
      expect(container.className).not.toContain("max-w-[");
    });

    it("选择手机尺寸时容器宽度限制为 375px", () => {
      render(<PreviewSurface threadId="t1" previewUrl="/preview/t1/index.html" reloadKey={0} />);
      fireEvent.click(screen.getByLabelText("手机"));
      const container = screen.getByTestId("preview-iframe-container");
      expect(container.className).toContain("max-w-[375px]");
    });

    it("选择平板尺寸时容器宽度限制为 768px", () => {
      render(<PreviewSurface threadId="t1" previewUrl="/preview/t1/index.html" reloadKey={0} />);
      fireEvent.click(screen.getByLabelText("平板"));
      const container = screen.getByTestId("preview-iframe-container");
      expect(container.className).toContain("max-w-[768px]");
    });

    it("选择桌面尺寸时容器宽度限制为 1280px", () => {
      render(<PreviewSurface threadId="t1" previewUrl="/preview/t1/index.html" reloadKey={0} />);
      fireEvent.click(screen.getByLabelText("桌面"));
      const container = screen.getByTestId("preview-iframe-container");
      expect(container.className).toContain("max-w-[1280px]");
    });
  });

  describe("iframe 安全", () => {
    it("iframe sandbox 不包含 allow-top-navigation（防导航劫持）", () => {
      render(<PreviewSurface threadId="t1" previewUrl="/preview/t1/index.html" reloadKey={0} />);
      const iframe = screen.getByTitle("项目预览") as HTMLIFrameElement;
      const sandbox = iframe.getAttribute("sandbox") || "";
      expect(sandbox).not.toContain("allow-top-navigation");
    });

    it("Web 不请求 /browser/session/start 或 /browser/session/offer", () => {
      render(<PreviewSurface threadId="t1" previewUrl="/preview/t1/index.html" reloadKey={0} />);
      // PreviewSurface 不应发起任何 browser session 相关请求
      const browserCalls = mockFetch.mock.calls.filter(
        ([url]) => typeof url === "string" && url.includes("/browser/session/"),
      );
      expect(browserCalls).toHaveLength(0);
    });
  });
});
