/**
 * Outbox Relay 领域逻辑单元测试。
 */

import { describe, expect, it } from "vitest";
import { classifyOutboxError, computeOutboxBackoff } from "./outbox-relay";

describe("computeOutboxBackoff", () => {
  it("基础退避：attemptCount=0 返回约 baseMs", () => {
    const result = computeOutboxBackoff(0, 1000, 60000);
    // 1000 * 2^0 + jitter = 1000 + [0, 200)
    expect(result.getTime()).toBeGreaterThan(Date.now() + 900);
    expect(result.getTime()).toBeLessThan(Date.now() + 1300);
  });

  it("指数增长：attemptCount=3 返回约 8*baseMs", () => {
    const result = computeOutboxBackoff(3, 1000, 60000);
    // 1000 * 2^3 = 8000 + jitter
    expect(result.getTime()).toBeGreaterThan(Date.now() + 7000);
    expect(result.getTime()).toBeLessThan(Date.now() + 10000);
  });

  it("不超过上限", () => {
    const result = computeOutboxBackoff(10, 1000, 5000);
    // 1000 * 2^10 = 1024000 > 5000, clamped to 5000 + jitter
    expect(result.getTime()).toBeGreaterThan(Date.now() + 4000);
    expect(result.getTime()).toBeLessThan(Date.now() + 7000);
  });
});

describe("classifyOutboxError", () => {
  it("not found → permanent", () => {
    const result = classifyOutboxError(new Error("Resource not found"));
    expect(result.category).toBe("permanent");
    expect(result.code).toBe("PERMANENT_ERROR");
  });

  it("constraint violation → permanent", () => {
    const result = classifyOutboxError(new Error("constraint violation in DB"));
    expect(result.category).toBe("permanent");
  });

  it("invalid format → permanent", () => {
    const result = classifyOutboxError(new Error("invalid format: payload"));
    expect(result.category).toBe("permanent");
  });

  it("timeout → retryable", () => {
    const result = classifyOutboxError(new Error("connection timeout"));
    expect(result.category).toBe("retryable");
    expect(result.code).toBe("TRANSIENT_ERROR");
  });

  it("ECONNREFUSED → retryable", () => {
    const result = classifyOutboxError(new Error("ECONNREFUSED 127.0.0.1:3306"));
    expect(result.category).toBe("retryable");
  });

  it("503 → retryable", () => {
    const result = classifyOutboxError(new Error("HTTP 503 Service Unavailable"));
    expect(result.category).toBe("retryable");
  });

  it("unknown error → retryable (conservative)", () => {
    const result = classifyOutboxError(new Error("something unexpected"));
    expect(result.category).toBe("retryable");
    expect(result.code).toBe("UNKNOWN_ERROR");
  });

  it("non-Error → retryable", () => {
    const result = classifyOutboxError("string error");
    expect(result.category).toBe("retryable");
  });

  it("DataValidationError name → permanent", () => {
    const err = new Error("bad data");
    err.name = "DataValidationError";
    const result = classifyOutboxError(err);
    expect(result.category).toBe("permanent");
  });

  it("§3.6: ControlPlaneEventUnsupportedError → permanent (Fail-loud)", () => {
    const err = new Error("控制面事件不支持: eventType=unknown.event, reason=未知事件类型");
    err.name = "ControlPlaneEventUnsupportedError";
    const result = classifyOutboxError(err);
    expect(result.category).toBe("permanent");
    expect(result.code).toBe("UNSUPPORTED_EVENT");
  });

  it("§3.2: ControlPlaneEventContractError → permanent", () => {
    const err = new Error("事件 agent.revision.published Payload 校验失败");
    err.name = "ControlPlaneEventContractError";
    const result = classifyOutboxError(err);
    expect(result.category).toBe("permanent");
    expect(result.code).toBe("EVENT_CONTRACT_VIOLATION");
  });
});
