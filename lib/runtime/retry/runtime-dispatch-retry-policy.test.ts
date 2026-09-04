import { RuntimeHttpClientError } from "@/lib/runtime/errors";
import { isTransientRuntimeError } from "@/lib/runtime/retry/runtime-dispatch-retry-policy";
import { describe, expect, it } from "vitest";

describe("Runtime dispatch retry policy", () => {
  it.each([
    new RuntimeHttpClientError("network", "connect", undefined, undefined, { retryable: true }),
    new RuntimeHttpClientError("network", "timeout", undefined, undefined, { retryable: true }),
    new RuntimeHttpClientError("http", "rate limited", 429),
    new RuntimeHttpClientError("http", "bad gateway", 502),
    new RuntimeHttpClientError("http", "unavailable", 503),
  ])("重试统一覆盖 connect/timeout/429/5xx", (error) => {
    expect(isTransientRuntimeError(error)).toBe(true);
  });

  it.each([
    new RuntimeHttpClientError("http", "unauthorized", 401),
    new RuntimeHttpClientError("http", "forbidden", 403),
    new RuntimeHttpClientError("protocol", "schema mismatch"),
    new RuntimeHttpClientError("network", "explicit terminal", undefined, undefined, {
      retryable: false,
    }),
  ])("身份、协议与显式不可重试错误 fail closed", (error) => {
    expect(isTransientRuntimeError(error)).toBe(false);
  });
});
