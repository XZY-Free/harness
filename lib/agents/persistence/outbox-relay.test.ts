/**
 * Outbox Relay 领域逻辑单元测试。
 */

import { describe, it, expect } from "vitest";
import {
  computeOutboxBackoff,
  classifyOutboxError,
  isOutboxEventClaimable,
} from "./outbox-relay";

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
});

describe("isOutboxEventClaimable", () => {
  const now = new Date();

  it("正常未处理事件可领取", () => {
    expect(isOutboxEventClaimable({
      publishedAt: null,
      deadLetteredAt: null,
      nextAttemptAt: null,
      lockExpiresAt: null,
      maxAttempts: null,
      attemptCount: 0,
    }, now, 10)).toBe(true);
  });

  it("已发布不可领取", () => {
    expect(isOutboxEventClaimable({
      publishedAt: now,
      deadLetteredAt: null,
      nextAttemptAt: null,
      lockExpiresAt: null,
      maxAttempts: null,
      attemptCount: 0,
    }, now, 10)).toBe(false);
  });

  it("已死信不可领取", () => {
    expect(isOutboxEventClaimable({
      publishedAt: null,
      deadLetteredAt: now,
      nextAttemptAt: null,
      lockExpiresAt: null,
      maxAttempts: null,
      attemptCount: 0,
    }, now, 10)).toBe(false);
  });

  it("达到最大尝试次数不可领取", () => {
    expect(isOutboxEventClaimable({
      publishedAt: null,
      deadLetteredAt: null,
      nextAttemptAt: null,
      lockExpiresAt: null,
      maxAttempts: null,
      attemptCount: 10,
    }, now, 10)).toBe(false);
  });

  it("下次尝试时间未到不可领取", () => {
    const future = new Date(now.getTime() + 60000);
    expect(isOutboxEventClaimable({
      publishedAt: null,
      deadLetteredAt: null,
      nextAttemptAt: future,
      lockExpiresAt: null,
      maxAttempts: null,
      attemptCount: 0,
    }, now, 10)).toBe(false);
  });

  it("租约未过期不可领取", () => {
    const future = new Date(now.getTime() + 60000);
    expect(isOutboxEventClaimable({
      publishedAt: null,
      deadLetteredAt: null,
      nextAttemptAt: null,
      lockExpiresAt: future,
      maxAttempts: null,
      attemptCount: 0,
    }, now, 10)).toBe(false);
  });

  it("租约已过期可领取", () => {
    const past = new Date(now.getTime() - 1000);
    expect(isOutboxEventClaimable({
      publishedAt: null,
      deadLetteredAt: null,
      nextAttemptAt: null,
      lockExpiresAt: past,
      maxAttempts: null,
      attemptCount: 0,
    }, now, 10)).toBe(true);
  });

  it("自定义 maxAttempts 优先于配置", () => {
    expect(isOutboxEventClaimable({
      publishedAt: null,
      deadLetteredAt: null,
      nextAttemptAt: null,
      lockExpiresAt: null,
      maxAttempts: 3,
      attemptCount: 3,
    }, now, 10)).toBe(false);
  });
});
