/**
 * S10-W01：error-messages 单元测试。
 *
 * 覆盖：
 * - toVisibleError 把服务端 envelope 映射为中文语义。
 * - 已知 code 使用映射表；未知 code 落到 GENERIC_UNKNOWN。
 * - retryable 直接采用服务端字段。
 * - request_id 保留（诊断用）。
 * - makeLocalVisibleError 本地构造（如 EVENT_SEQUENCE_GAP）。
 */
import { describe, expect, it } from "vitest";
import { makeLocalVisibleError, toVisibleError } from "./error-messages";
import type { ClientErrorBody } from "./types";

function envelope(code: string, retryable = false, requestId = "req_test"): ClientErrorBody {
  return {
    error: {
      code,
      message: `server message for ${code}`,
      request_id: requestId,
      retryable,
    },
  };
}

describe("toVisibleError", () => {
  it("映射已知错误码 EVENT_CURSOR_EXPIRED", () => {
    const err = toVisibleError(envelope("EVENT_CURSOR_EXPIRED", false));
    expect(err.code).toBe("EVENT_CURSOR_EXPIRED");
    expect(err.title).toBe("会话已过期");
    expect(err.recoveryAction).toBe("resnapshot");
    expect(err.retryable).toBe(false);
    expect(err.requestId).toBe("req_test");
  });

  it("映射已知错误码 AUTHENTICATION_REQUIRED", () => {
    const err = toVisibleError(envelope("AUTHENTICATION_REQUIRED"));
    expect(err.title).toBe("登录已失效");
    expect(err.recoveryAction).toBe("reload_page");
  });

  it("映射已知错误码 RATE_LIMITED（retryable=true）", () => {
    const err = toVisibleError(envelope("RATE_LIMITED", true));
    expect(err.title).toBe("请求过于频繁");
    expect(err.retryable).toBe(true);
    expect(err.recoveryAction).toBe("reconnect");
  });

  it("映射已知错误码 RESOURCE_NOT_FOUND", () => {
    const err = toVisibleError(envelope("RESOURCE_NOT_FOUND"));
    expect(err.title).toBe("内容不存在");
    expect(err.recoveryAction).toBe("reload_page");
  });

  it("映射已知错误码 ETAG_MISMATCH", () => {
    const err = toVisibleError(envelope("ETAG_MISMATCH", true));
    expect(err.title).toBe("数据已被更新");
    expect(err.recoveryAction).toBe("reload_page");
  });

  it("未知错误码落到 GENERIC_UNKNOWN，不暴露内部细节", () => {
    const err = toVisibleError(envelope("INTERNAL_DB_DEADLOCK"));
    expect(err.code).toBe("INTERNAL_DB_DEADLOCK");
    expect(err.title).toBe("操作未完成");
    expect(err.description).toContain("系统暂时无法完成");
    expect(err.recoveryAction).toBe("reload_page");
  });

  it("retryable 直接采用服务端 envelope 字段", () => {
    expect(toVisibleError(envelope("EVENT_SEQUENCE_GAP", true)).retryable).toBe(true);
    expect(toVisibleError(envelope("EVENT_CURSOR_EXPIRED", false)).retryable).toBe(false);
  });

  it("request_id 保留（诊断用）", () => {
    const err = toVisibleError(envelope("EVENT_CURSOR_EXPIRED", false, "req_abc123"));
    expect(err.requestId).toBe("req_abc123");
  });
});

describe("makeLocalVisibleError", () => {
  it("本地构造 EVENT_SEQUENCE_GAP", () => {
    const err = makeLocalVisibleError({ code: "EVENT_SEQUENCE_GAP", retryable: true });
    expect(err.code).toBe("EVENT_SEQUENCE_GAP");
    expect(err.title).toBe("同步出现空缺");
    expect(err.recoveryAction).toBe("resnapshot");
    expect(err.retryable).toBe(true);
    expect(err.requestId).toBeNull();
  });

  it("本地构造未知 code 落到 GENERIC_UNKNOWN", () => {
    const err = makeLocalVisibleError({ code: "LOCAL_FAKE" });
    expect(err.title).toBe("操作未完成");
    expect(err.retryable).toBe(false);
  });
});
