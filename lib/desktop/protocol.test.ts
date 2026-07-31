import {
  PROTOCOL_VERSION,
  type ProtocolVersion,
  isCompatibleVersion,
} from "@/lib/desktop/protocol";
import { describe, expect, it } from "vitest";

describe("PROTOCOL_VERSION", () => {
  it("是正整数", () => {
    expect(Number.isInteger(PROTOCOL_VERSION)).toBe(true);
    expect(PROTOCOL_VERSION).toBeGreaterThan(0);
  });

  it("当前版本为 1", () => {
    expect(PROTOCOL_VERSION).toBe(1);
  });

  it("类型为 ProtocolVersion", () => {
    const v: ProtocolVersion = PROTOCOL_VERSION;
    expect(v).toBe(PROTOCOL_VERSION);
  });
});

describe("isCompatibleVersion()", () => {
  it("兼容版本（等于 PROTOCOL_VERSION）通过", () => {
    expect(isCompatibleVersion(PROTOCOL_VERSION)).toBe(true);
    expect(isCompatibleVersion(1)).toBe(true);
  });

  it("不兼容版本拒绝（高于当前版本）", () => {
    expect(isCompatibleVersion(2)).toBe(false);
    expect(isCompatibleVersion(999)).toBe(false);
  });

  it("不兼容版本拒绝（低于当前版本）", () => {
    expect(isCompatibleVersion(0)).toBe(false);
  });

  it("不兼容版本拒绝（负数）", () => {
    expect(isCompatibleVersion(-1)).toBe(false);
  });

  it("不兼容版本拒绝（NaN）", () => {
    expect(isCompatibleVersion(Number.NaN)).toBe(false);
  });

  it("不兼容版本拒绝（浮点数）", () => {
    expect(isCompatibleVersion(1.5)).toBe(false);
  });
});
