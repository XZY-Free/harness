/**
 * V10 Phase 6：WebContentsDebuggerTarget 单元测试。
 *
 * 验证 WebContentsDebuggerTarget 正确包装 Electron 的 webContents.debugger API：
 * - attach：调用 webContents.debugger.attach('1.3')，已附加时不抛错
 * - detach：调用 webContents.debugger.detach()
 * - isAttached：返回 webContents.debugger.isAttached 属性值
 * - sendCommand：成功返回 { ok: true, result }，失败返回 { ok: false, error }
 *
 * 使用 mock webContents.debugger，不依赖真实 Electron 运行时。
 */
import type { WebContents } from "electron";
import { describe, expect, it, vi } from "vitest";
import { WebContentsDebuggerTarget } from "./debugger-target";

/** 创建 mock webContents，模拟 Electron 的 debugger API */
function createMockWebContents(): WebContents & {
  debugger: {
    attach: ReturnType<typeof vi.fn>;
    detach: ReturnType<typeof vi.fn>;
    sendCommand: ReturnType<typeof vi.fn>;
    isAttached: ReturnType<typeof vi.fn>;
  };
} {
  return {
    debugger: {
      attach: vi.fn(),
      detach: vi.fn(),
      sendCommand: vi.fn(),
      isAttached: vi.fn(() => false),
    },
  } as unknown as WebContents & {
    debugger: {
      attach: ReturnType<typeof vi.fn>;
      detach: ReturnType<typeof vi.fn>;
      sendCommand: ReturnType<typeof vi.fn>;
      isAttached: ReturnType<typeof vi.fn>;
    };
  };
}

describe("WebContentsDebuggerTarget", () => {
  describe("attach", () => {
    it("未附加时调用 webContents.debugger.attach('1.3')", () => {
      const wc = createMockWebContents();
      const target = new WebContentsDebuggerTarget(wc);

      target.attach();

      expect(wc.debugger.attach).toHaveBeenCalledWith("1.3");
      expect(wc.debugger.attach).toHaveBeenCalledTimes(1);
    });

    it("已附加时不重复 attach（吞掉 already-attached 错误）", () => {
      const wc = createMockWebContents();
      wc.debugger.attach.mockImplementation(() => {
        throw new Error("Another debugger is already attached");
      });
      const target = new WebContentsDebuggerTarget(wc);

      expect(() => target.attach()).not.toThrow();
      expect(wc.debugger.attach).toHaveBeenCalledTimes(1);
    });

    it("其他 attach 错误也吞掉（调用方通过 isAttached 判断状态）", () => {
      const wc = createMockWebContents();
      wc.debugger.attach.mockImplementation(() => {
        throw new Error("unexpected error");
      });
      const target = new WebContentsDebuggerTarget(wc);

      expect(() => target.attach()).not.toThrow();
    });
  });

  describe("detach", () => {
    it("调用 webContents.debugger.detach()", () => {
      const wc = createMockWebContents();
      const target = new WebContentsDebuggerTarget(wc);

      target.detach();

      expect(wc.debugger.detach).toHaveBeenCalledTimes(1);
    });

    it("detach 抛错时静默忽略", () => {
      const wc = createMockWebContents();
      wc.debugger.detach.mockImplementation(() => {
        throw new Error("not attached");
      });
      const target = new WebContentsDebuggerTarget(wc);

      expect(() => target.detach()).not.toThrow();
    });
  });

  describe("isAttached", () => {
    it("未附加时返回 false", () => {
      const wc = createMockWebContents();
      wc.debugger.isAttached.mockReturnValue(false);
      const target = new WebContentsDebuggerTarget(wc);

      expect(target.isAttached()).toBe(false);
    });

    it("已附加时返回 true", () => {
      const wc = createMockWebContents();
      wc.debugger.isAttached.mockReturnValue(true);
      const target = new WebContentsDebuggerTarget(wc);

      expect(target.isAttached()).toBe(true);
    });

    it("isAttached 返回值变化时反映最新值", () => {
      const wc = createMockWebContents();
      const target = new WebContentsDebuggerTarget(wc);

      wc.debugger.isAttached.mockReturnValue(false);
      expect(target.isAttached()).toBe(false);
      wc.debugger.isAttached.mockReturnValue(true);
      expect(target.isAttached()).toBe(true);
      wc.debugger.isAttached.mockReturnValue(false);
      expect(target.isAttached()).toBe(false);
    });
  });

  describe("sendCommand", () => {
    it("成功时返回 { ok: true, result }", async () => {
      const wc = createMockWebContents();
      wc.debugger.sendCommand.mockResolvedValue({ result: { root: { nodeId: 1 } } });
      const target = new WebContentsDebuggerTarget(wc);

      const result = await target.sendCommand("DOM.getDocument", { depth: 1 });

      expect(result.ok).toBe(true);
      expect(result.result).toEqual({ root: { nodeId: 1 } });
      expect(wc.debugger.sendCommand).toHaveBeenCalledWith("DOM.getDocument", { depth: 1 });
    });

    it("无 params 参数时仅传 method", async () => {
      const wc = createMockWebContents();
      wc.debugger.sendCommand.mockResolvedValue({ result: {} });
      const target = new WebContentsDebuggerTarget(wc);

      await target.sendCommand("Page.enable");

      expect(wc.debugger.sendCommand).toHaveBeenCalledWith("Page.enable", undefined);
    });

    it("reject 时返回 { ok: false, error }", async () => {
      const wc = createMockWebContents();
      wc.debugger.sendCommand.mockRejectedValue(new Error("CDP command failed"));
      const target = new WebContentsDebuggerTarget(wc);

      const result = await target.sendCommand("DOM.querySelector", { selector: "#x" });

      expect(result.ok).toBe(false);
      expect(result.error).toBe("CDP command failed");
    });

    it("reject 为非 Error 时返回 String(error)", async () => {
      const wc = createMockWebContents();
      wc.debugger.sendCommand.mockRejectedValue("string error");
      const target = new WebContentsDebuggerTarget(wc);

      const result = await target.sendCommand("DOM.getDocument");

      expect(result.ok).toBe(false);
      expect(result.error).toBe("string error");
    });

    it("返回值无 result 字段时使用整个返回值", async () => {
      const wc = createMockWebContents();
      wc.debugger.sendCommand.mockResolvedValue({ custom: "data" });
      const target = new WebContentsDebuggerTarget(wc);

      const result = await target.sendCommand("Custom.command");

      expect(result.ok).toBe(true);
      expect(result.result).toEqual({ custom: "data" });
    });
  });
});
