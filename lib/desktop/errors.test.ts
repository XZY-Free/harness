import {
  DesktopErrorCode as Codes,
  type DesktopError,
  type DesktopErrorCode,
  desktopError,
  isDesktopError,
} from "@/lib/desktop/errors";
import { describe, expect, it } from "vitest";

describe("DesktopErrorCode", () => {
  it("所有错误码为非空字符串", () => {
    const codes = Object.values(Codes);
    expect(codes.length).toBeGreaterThan(10);
    for (const code of codes) {
      expect(typeof code).toBe("string");
      expect(code.length).toBeGreaterThan(0);
    }
  });

  it("错误码不重复", () => {
    const codes = Object.values(Codes);
    const set = new Set(codes);
    expect(set.size).toBe(codes.length);
  });

  it("desktop_unavailable 码值与 Browser Tool 返回一致", () => {
    expect(Codes.DESKTOP_UNAVAILABLE).toBe("desktop_unavailable");
  });
});

describe("desktopError()", () => {
  it("构造基础错误体", () => {
    const err = desktopError(Codes.DESKTOP_UNAVAILABLE, "Desktop 离线");
    expect(err.ok).toBe(false);
    expect(err.code).toBe("desktop_unavailable");
    expect(err.message).toBe("Desktop 离线");
    expect(err.detail).toBeUndefined();
  });

  it("构造带 detail 的错误体", () => {
    const err = desktopError(Codes.RPC_TIMEOUT, "命令超时", {
      requestId: "req-1",
      timeoutMs: 5000,
    });
    expect(err.ok).toBe(false);
    expect(err.code).toBe("rpc_timeout");
    expect(err.detail).toEqual({ requestId: "req-1", timeoutMs: 5000 });
  });
});

describe("isDesktopError()", () => {
  it("识别合法 DesktopError", () => {
    const err: DesktopError = {
      ok: false,
      code: "desktop_unavailable" as DesktopErrorCode,
      message: "test",
    };
    expect(isDesktopError(err)).toBe(true);
  });

  it("识别 desktopError() 构造的结果", () => {
    expect(isDesktopError(desktopError(Codes.ORIGIN_REJECTED, "bad"))).toBe(true);
  });

  it("拒绝 null", () => {
    expect(isDesktopError(null)).toBe(false);
  });

  it("拒绝 undefined", () => {
    expect(isDesktopError(undefined)).toBe(false);
  });

  it("拒绝原始字符串", () => {
    expect(isDesktopError("error")).toBe(false);
  });

  it("拒绝 ok:true 的对象", () => {
    expect(isDesktopError({ ok: true, code: "x", message: "y" })).toBe(false);
  });

  it("拒绝缺少 code 的对象", () => {
    expect(isDesktopError({ ok: false, message: "y" })).toBe(false);
  });

  it("拒绝缺少 message 的对象", () => {
    expect(isDesktopError({ ok: false, code: "x" })).toBe(false);
  });
});
