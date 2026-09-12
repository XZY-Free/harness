import {
  MIN_ACCEPTABLE_STRENGTH,
  isPasswordAcceptable,
  isPasswordLengthAcceptable,
  passwordStrengthScore,
} from "@/lib/identity/password-strength";
import { describe, expect, it } from "vitest";

describe("passwordStrengthScore", () => {
  it("空密码为 0 档", () => {
    expect(passwordStrengthScore("")).toBe(0);
  });

  it("长度不足一律 1 档", () => {
    expect(passwordStrengthScore("Ab1!xyz")).toBe(1);
  });

  it("常见密码/序列/重复即使够长也 1 档", () => {
    for (const weak of [
      "password123",
      "12345678",
      "aaaaaaaa",
      "abc12345",
      "0123456789xx",
      "qwertyuiop",
    ]) {
      expect(passwordStrengthScore(weak), weak).toBe(1);
    }
  });

  it("长度档与字符类加成递增", () => {
    expect(passwordStrengthScore("wuchao26")).toBe(1);
    expect(passwordStrengthScore("wuchao2026")).toBe(1);
    expect(passwordStrengthScore("wuchao@26")).toBe(2);
    expect(passwordStrengthScore("wuchao@2026")).toBe(2);
    expect(passwordStrengthScore("wuchao@2026xx")).toBe(3);
    expect(passwordStrengthScore("Sn0w-Harn3ss!2026")).toBe(4);
  });
});

describe("长度与可接受性", () => {
  it("长度边界 8 与 128", () => {
    expect(isPasswordLengthAcceptable("a".repeat(7))).toBe(false);
    expect(isPasswordLengthAcceptable("a".repeat(8))).toBe(true);
    expect(isPasswordLengthAcceptable("a".repeat(128))).toBe(true);
    expect(isPasswordLengthAcceptable("a".repeat(129))).toBe(false);
  });

  it("isPasswordAcceptable 组合长度与强度门槛", () => {
    expect(isPasswordAcceptable("abc")).toBe(false);
    expect(isPasswordAcceptable("abc12345")).toBe(false);
    expect(isPasswordAcceptable("wuchao@2026")).toBe(true);
    expect(MIN_ACCEPTABLE_STRENGTH).toBe(2);
  });
});
