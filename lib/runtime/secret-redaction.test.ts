import { describe, expect, it } from "vitest";
import { clearThreadSecrets, redactText, registerSecretValues } from "./secret-redaction";

/**
 * S1 修复（02-P2-2）：secret 最小长度测试。
 * 短于 4 字符的值不注册脱敏（避免 1-3 字符 secret 把正文同字符串误替换成 ***）。
 */

describe("registerSecretValues 最小长度", () => {
  const TID = "t-redact";

  it(">= 4 字符的 secret 注册并脱敏", () => {
    registerSecretValues(TID, ["sk-1234567890"]);
    expect(redactText("token=sk-1234567890 here", TID)).toBe("token=*** here");
    clearThreadSecrets(TID);
  });

  it("< 4 字符的 short secret 不注册（不脱敏，保留正文可读性）", () => {
    registerSecretValues(TID, ["ab", "x", ""]);
    // "ab" 在正文中出现但不被脱敏
    expect(redactText("lab ab tab", TID)).toBe("lab ab tab");
    clearThreadSecrets(TID);
  });

  it("混合：长 secret 脱敏，短 secret 不脱敏", () => {
    registerSecretValues(TID, ["ab", "long-secret-123"]);
    const out = redactText("ab and long-secret-123", TID);
    expect(out).toContain("ab"); // 短 secret 保留
    expect(out).not.toContain("long-secret-123"); // 长 secret 脱敏
    expect(out).toContain("***");
    clearThreadSecrets(TID);
  });
});
