/**
 * S12-W05：V11 Secret 扫描器单元测试。
 *
 * 覆盖：
 * - SECRET_PATTERNS（AWS/GitHub/PEM/JWT/Slack/Google/Stripe 7 种正则模式）
 * - scanStringForSecrets：扫描字符串中的已知 Secret 模式
 * - redactStringSecrets：替换字符串中的 Secret 为 [REDACTED:{name}]
 * - scanForKnownPlaintext：扫描任意值中的已知明文 Secret
 * - redactKnownPlaintext：替换字符串中的已知明文 Secret 为 [REDACTED]
 * - scanSecrets：组合扫描（模式 + 明文 + 禁采字段名）
 */
import {
  SECRET_PATTERNS,
  redactKnownPlaintext,
  redactStringSecrets,
  scanForKnownPlaintext,
  scanSecrets,
  scanStringForSecrets,
} from "@/lib/v11/security/secret-scanner";
import { afterEach, describe, expect, it } from "vitest";

// ═══════════════════════════════════════════════════════════
// 1. SECRET_PATTERNS 定义
// ═══════════════════════════════════════════════════════════

describe("V11 SECRET_PATTERNS 定义", () => {
  it("包含 7 种 Secret 模式", () => {
    expect(SECRET_PATTERNS.length).toBe(7);
  });

  it("模式 name 唯一且非空", () => {
    const names = SECRET_PATTERNS.map((p) => p.name);
    expect(new Set(names).size).toBe(names.length);
    for (const name of names) {
      expect(name.length).toBeGreaterThan(0);
    }
  });

  it("所有 pattern 都是全局正则", () => {
    for (const { pattern } of SECRET_PATTERNS) {
      expect(pattern.global).toBe(true);
    }
  });

  it("包含预期的模式名", () => {
    const names = SECRET_PATTERNS.map((p) => p.name);
    expect(names).toContain("aws_access_key_id");
    expect(names).toContain("github_token");
    expect(names).toContain("private_key_pem");
    expect(names).toContain("jwt");
    expect(names).toContain("slack_token");
    expect(names).toContain("google_api_key");
    expect(names).toContain("stripe_secret_key");
  });
});

// ═══════════════════════════════════════════════════════════
// 2. scanStringForSecrets
// ═══════════════════════════════════════════════════════════

describe("V11 scanStringForSecrets", () => {
  it("AWS Access Key 匹配 AKIA 开头 20 字符", () => {
    const value = "aws key: AKIAIOSFODNN7EXAMPLE";
    const matches = scanStringForSecrets(value);
    const awsMatch = matches.find((m) => m.name === "aws_access_key_id");
    expect(awsMatch).toBeDefined();
    expect(awsMatch?.length).toBe(20);
    expect(awsMatch?.preview).toBe("AKIA");
    expect(awsMatch?.index).toBe(9);
  });

  it("AWS Access Key 不匹配非 AKIA 开头", () => {
    const matches = scanStringForSecrets("AKABIOSFODNN7EXAMPLE");
    expect(matches.find((m) => m.name === "aws_access_key_id")).toBeUndefined();
  });

  it("GitHub Token 匹配 ghp_ 开头 36 字符", () => {
    const value = "token: ghp_0123456789abcdefghijklmnopqrstuvwxyz";
    const matches = scanStringForSecrets(value);
    const ghMatch = matches.find((m) => m.name === "github_token");
    expect(ghMatch).toBeDefined();
    expect(ghMatch?.preview).toBe("ghp_");
  });

  it("GitHub Token 匹配 ghs_ 前缀", () => {
    const value = "secret ghs_0123456789abcdefghijklmnopqrstuvwxyz";
    const matches = scanStringForSecrets(value);
    expect(matches.find((m) => m.name === "github_token")).toBeDefined();
  });

  it("PEM 私钥匹配（多行）", () => {
    const value = `key:
-----BEGIN RSA PRIVATE KEY-----
MIIEpAIBAAKCAQEA0123456789abcdefghijklmnopqrstuvwxyz
-----END RSA PRIVATE KEY-----
end`;
    const matches = scanStringForSecrets(value);
    const pemMatch = matches.find((m) => m.name === "private_key_pem");
    expect(pemMatch).toBeDefined();
    expect(pemMatch?.length).toBeGreaterThan(0);
  });

  it("PEM 私钥匹配 OPENSSH 格式", () => {
    const value = `-----BEGIN OPENSSH PRIVATE KEY-----
b3BlbnNzaC1rZXktdjEAAAAABG5vbmUAAAA
-----END OPENSSH PRIVATE KEY-----`;
    const matches = scanStringForSecrets(value);
    expect(matches.find((m) => m.name === "private_key_pem")).toBeDefined();
  });

  it("PEM 私钥匹配 EC 格式", () => {
    const value = `-----BEGIN EC PRIVATE KEY-----
MHcCAQEEIBEz2gMv
-----END EC PRIVATE KEY-----`;
    const matches = scanStringForSecrets(value);
    expect(matches.find((m) => m.name === "private_key_pem")).toBeDefined();
  });

  it("JWT 匹配三段式 eyJ.eyJ.签名", () => {
    const value =
      "auth: eyJhbGciOiJIUzI1NiJ9.eyJzdWIiOiIxMjM0NTY3ODkwIn0.SflKxwRJSMeKKF2QT4fwpMeJf36POk6yJV_adQssw5c";
    const matches = scanStringForSecrets(value);
    const jwtMatch = matches.find((m) => m.name === "jwt");
    expect(jwtMatch).toBeDefined();
    expect(jwtMatch?.preview).toBe("eyJh");
  });

  it("Slack Token 匹配 xox[baprs]- 前缀", () => {
    const value = "slack: xoxb-1234567890-abcdefghij";
    const matches = scanStringForSecrets(value);
    const slackMatch = matches.find((m) => m.name === "slack_token");
    expect(slackMatch).toBeDefined();
    expect(slackMatch?.preview).toBe("xoxb");
  });

  it("Slack Token 匹配 xoxp- 前缀", () => {
    const value = "xoxp-1234567890-abcdefghij";
    const matches = scanStringForSecrets(value);
    expect(matches.find((m) => m.name === "slack_token")).toBeDefined();
  });

  it("Google API Key 匹配 AIza 开头 39 字符", () => {
    const value = "google: AIzaSyA1234567890abcdefghijklmnopqrstuv";
    const matches = scanStringForSecrets(value);
    const googleMatch = matches.find((m) => m.name === "google_api_key");
    expect(googleMatch).toBeDefined();
    expect(googleMatch?.preview).toBe("AIza");
  });

  it("Stripe Secret Key 匹配 sk_live_ 前缀", () => {
    const value = "stripe: sk_live_0123456789abcdefghijklmn";
    const matches = scanStringForSecrets(value);
    const stripeMatch = matches.find((m) => m.name === "stripe_secret_key");
    expect(stripeMatch).toBeDefined();
    expect(stripeMatch?.preview).toBe("sk_l");
  });

  it("Stripe Secret Key 匹配 sk_test_ 前缀", () => {
    const value = "sk_test_0123456789abcdefghijklmn";
    const matches = scanStringForSecrets(value);
    expect(matches.find((m) => m.name === "stripe_secret_key")).toBeDefined();
  });

  it("普通字符串不匹配任何 Secret", () => {
    const matches = scanStringForSecrets("hello world 12345");
    expect(matches).toEqual([]);
  });

  it("空字符串不匹配", () => {
    expect(scanStringForSecrets("")).toEqual([]);
  });

  it("多个 Secret 同时扫描", () => {
    const value = "aws=AKIAIOSFODNN7EXAMPLE github=ghp_0123456789abcdefghijklmnopqrstuvwxyz";
    const matches = scanStringForSecrets(value);
    expect(matches.length).toBe(2);
    const names = matches.map((m) => m.name).sort();
    expect(names).toEqual(["aws_access_key_id", "github_token"]);
  });

  it("同一模式多次匹配", () => {
    const value = "key1=AKIAIOSFODNN7EXAMPLE key2=AKIAEXAMPLE12345678A";
    const matches = scanStringForSecrets(value);
    const awsMatches = matches.filter((m) => m.name === "aws_access_key_id");
    expect(awsMatches.length).toBe(2);
  });

  it("preview 仅含前 4 字符（不暴露完整 Secret）", () => {
    const value = "AKIAIOSFODNN7EXAMPLE";
    const matches = scanStringForSecrets(value);
    expect(matches[0]?.preview?.length).toBe(4);
  });

  it("匹配结果不含原文 Secret（仅 preview + 位置）", () => {
    const value = "AKIAIOSFODNN7EXAMPLE";
    const matches = scanStringForSecrets(value);
    const serialized = JSON.stringify(matches);
    expect(serialized).not.toContain("AKIAIOSFODNN7EXAMPLE");
  });

  it("不修改全局正则 lastIndex（可重复调用）", () => {
    const value = "AKIAIOSFODNN7EXAMPLE";
    const first = scanStringForSecrets(value);
    const second = scanStringForSecrets(value);
    expect(second.length).toBe(first.length);
    expect(second[0]?.name).toBe(first[0]?.name);
  });
});

// ═══════════════════════════════════════════════════════════
// 3. redactStringSecrets
// ═══════════════════════════════════════════════════════════

describe("V11 redactStringSecrets", () => {
  it("替换 AWS Access Key 为 [REDACTED:aws_access_key_id]", () => {
    const result = redactStringSecrets("key: AKIAIOSFODNN7EXAMPLE end");
    expect(result).toBe("key: [REDACTED:aws_access_key_id] end");
  });

  it("替换 GitHub Token", () => {
    const result = redactStringSecrets("token ghp_0123456789abcdefghijklmnopqrstuvwxyz end");
    expect(result).toBe("token [REDACTED:github_token] end");
  });

  it("替换 PEM 私钥", () => {
    const value = `before-----BEGIN RSA PRIVATE KEY-----
MIIEpAIBAAKCAQEA
-----END RSA PRIVATE KEY-----after`;
    const result = redactStringSecrets(value);
    expect(result).toBe("before[REDACTED:private_key_pem]after");
  });

  it("替换 JWT", () => {
    const result = redactStringSecrets(
      "auth: eyJhbGciOiJIUzI1NiJ9.eyJzdWIiOiIxMjM0NTY3ODkwIn0.SflKxwRJSMeKKF2QT4fwpMeJf36POk6yJV_adQssw5c",
    );
    expect(result).toBe("auth: [REDACTED:jwt]");
  });

  it("替换 Slack Token", () => {
    const result = redactStringSecrets("slack: xoxb-1234567890-abcdefghij");
    expect(result).toBe("slack: [REDACTED:slack_token]");
  });

  it("替换 Google API Key", () => {
    const result = redactStringSecrets("google: AIzaSyA1234567890abcdefghijklmnopqrstuv");
    expect(result).toBe("google: [REDACTED:google_api_key]");
  });

  it("替换 Stripe Secret Key", () => {
    const result = redactStringSecrets("stripe: sk_live_0123456789abcdefghijklmn");
    expect(result).toBe("stripe: [REDACTED:stripe_secret_key]");
  });

  it("无 Secret 的字符串原样返回", () => {
    const result = redactStringSecrets("hello world");
    expect(result).toBe("hello world");
  });

  it("空字符串原样返回", () => {
    expect(redactStringSecrets("")).toBe("");
  });

  it("多个 Secret 同时替换", () => {
    const value = "aws=AKIAIOSFODNN7EXAMPLE github=ghp_0123456789abcdefghijklmnopqrstuvwxyz";
    const result = redactStringSecrets(value);
    expect(result).toBe("aws=[REDACTED:aws_access_key_id] github=[REDACTED:github_token]");
  });

  it("同一模式多次出现全部替换", () => {
    const value = "AKIAIOSFODNN7EXAMPLE AKIAEXAMPLE12345678A";
    const result = redactStringSecrets(value);
    expect(result).toBe("[REDACTED:aws_access_key_id] [REDACTED:aws_access_key_id]");
  });

  it("替换后结果不含原文 Secret", () => {
    const result = redactStringSecrets("AKIAIOSFODNN7EXAMPLE");
    expect(result).not.toContain("AKIAIOSFODNN7EXAMPLE");
  });
});

// ═══════════════════════════════════════════════════════════
// 4. scanForKnownPlaintext
// ═══════════════════════════════════════════════════════════

describe("V11 scanForKnownPlaintext", () => {
  it("空明文值集合返回空结果", () => {
    expect(scanForKnownPlaintext("hello", [])).toEqual([]);
  });

  it("字符串中包含已知明文值 → 匹配", () => {
    const matches = scanForKnownPlaintext("my-secret-value", ["my-secret-value"]);
    expect(matches.length).toBe(1);
    expect(matches[0]?.name).toBe("known_plaintext");
    expect(matches[0]?.length).toBe("my-secret-value".length);
    expect(matches[0]?.preview).toBe("my-s");
  });

  it("字符串不包含已知明文值 → 不匹配", () => {
    expect(scanForKnownPlaintext("hello", ["world"])).toEqual([]);
  });

  it("明文值长度 < 4 被跳过（防误伤）", () => {
    expect(scanForKnownPlaintext("abc", ["abc"])).toEqual([]);
    expect(scanForKnownPlaintext("abcd", ["abcd"]).length).toBe(1);
  });

  it("同一明文多次出现全部匹配", () => {
    const value = "secret secret secret";
    const matches = scanForKnownPlaintext(value, ["secret"]);
    expect(matches.length).toBe(3);
  });

  it("递归遍历对象", () => {
    const value = { a: "my-secret", b: { c: "my-secret" } };
    const matches = scanForKnownPlaintext(value, ["my-secret"]);
    expect(matches.length).toBe(2);
  });

  it("递归遍历数组", () => {
    const value = ["my-secret", "other", "my-secret"];
    const matches = scanForKnownPlaintext(value, ["my-secret"]);
    expect(matches.length).toBe(2);
  });

  it("递归遍历嵌套对象 + 数组", () => {
    const value = { list: [{ key: "my-secret" }, "no-match"] };
    const matches = scanForKnownPlaintext(value, ["my-secret"]);
    expect(matches.length).toBe(1);
  });

  it("多个明文值同时扫描", () => {
    const value = "foo-value bar-value";
    const matches = scanForKnownPlaintext(value, ["foo-value", "bar-value"]);
    expect(matches.length).toBe(2);
  });

  it("匹配结果不含原文 Secret", () => {
    const secret = "super-secret-value";
    const matches = scanForKnownPlaintext(secret, [secret]);
    const serialized = JSON.stringify(matches);
    expect(serialized).not.toContain(secret);
  });

  it("null / undefined / 数字 / 布尔不抛错", () => {
    expect(scanForKnownPlaintext(null, ["secret"])).toEqual([]);
    expect(scanForKnownPlaintext(undefined, ["secret"])).toEqual([]);
    expect(scanForKnownPlaintext(42, ["secret"])).toEqual([]);
    expect(scanForKnownPlaintext(true, ["secret"])).toEqual([]);
  });
});

// ═══════════════════════════════════════════════════════════
// 5. redactKnownPlaintext
// ═══════════════════════════════════════════════════════════

describe("V11 redactKnownPlaintext", () => {
  it("替换已知明文为 [REDACTED]", () => {
    const result = redactKnownPlaintext("my-secret-value", ["my-secret-value"]);
    expect(result).toBe("[REDACTED]");
  });

  it("无匹配时原样返回", () => {
    expect(redactKnownPlaintext("hello", ["world"])).toBe("hello");
  });

  it("空明文值集合原样返回", () => {
    expect(redactKnownPlaintext("hello", [])).toBe("hello");
  });

  it("明文值长度 < 4 被跳过", () => {
    expect(redactKnownPlaintext("abc", ["abc"])).toBe("abc");
  });

  it("多次出现全部替换", () => {
    const result = redactKnownPlaintext("secret secret secret", ["secret"]);
    expect(result).toBe("[REDACTED] [REDACTED] [REDACTED]");
  });

  it("按长度降序替换（长串优先，避免短串破坏长串）", () => {
    const result = redactKnownPlaintext("super-secret-value", ["super", "super-secret-value"]);
    expect(result).toBe("[REDACTED]");
  });

  it("替换后结果不含原文明文", () => {
    const secret = "super-secret-value";
    const result = redactKnownPlaintext(secret, [secret]);
    expect(result).not.toContain(secret);
  });

  it("多个明文同时替换", () => {
    const result = redactKnownPlaintext("foo-value bar-value", ["foo-value", "bar-value"]);
    expect(result).toBe("[REDACTED] [REDACTED]");
  });

  it("短明文值（< 4）不参与替换", () => {
    const result = redactKnownPlaintext("abc defg", ["abc", "defg"]);
    expect(result).toBe("abc [REDACTED]");
  });
});

// ═══════════════════════════════════════════════════════════
// 6. scanSecrets（组合扫描）
// ═══════════════════════════════════════════════════════════

describe("V11 scanSecrets 组合扫描", () => {
  afterEach(() => {
    // 无全局状态需清理
  });

  it("扫描字符串中的 Secret 模式", () => {
    const result = scanSecrets("key: AKIAIOSFODNN7EXAMPLE");
    expect(result.found).toBe(true);
    expect(result.matches.some((m) => m.name === "aws_access_key_id")).toBe(true);
  });

  it("扫描字符串中的已知明文值", () => {
    const result = scanSecrets("my-secret-value", ["my-secret-value"]);
    expect(result.found).toBe(true);
    expect(result.matches.some((m) => m.name === "known_plaintext")).toBe(true);
  });

  it("扫描对象中的禁采字段名", () => {
    const result = scanSecrets({ password: "123456", name: "user" });
    expect(result.found).toBe(true);
    expect(result.matches.some((m) => m.name === "forbidden_field")).toBe(true);
  });

  it("递归扫描嵌套对象", () => {
    const result = scanSecrets({
      outer: { password: "x", token: "AKIAIOSFODNN7EXAMPLE" },
    });
    expect(result.found).toBe(true);
    const names = result.matches.map((m) => m.name);
    expect(names).toContain("forbidden_field");
    expect(names).toContain("aws_access_key_id");
  });

  it("递归扫描数组", () => {
    const result = scanSecrets(["AKIAIOSFODNN7EXAMPLE", "plain"]);
    expect(result.found).toBe(true);
  });

  it("无 Secret 时 found=false", () => {
    const result = scanSecrets({ name: "user", age: 30 });
    expect(result.found).toBe(false);
    expect(result.matches).toEqual([]);
  });

  it("组合扫描：模式 + 明文 + 禁采字段同时出现", () => {
    const result = scanSecrets(
      {
        password: "my-secret-value",
        token: "AKIAIOSFODNN7EXAMPLE",
      },
      ["my-secret-value"],
    );
    expect(result.found).toBe(true);
    const names = result.matches.map((m) => m.name);
    expect(names).toContain("forbidden_field");
    expect(names).toContain("aws_access_key_id");
    expect(names).toContain("known_plaintext");
  });

  it("不传明文值集合时仅扫描模式 + 禁采字段", () => {
    const result = scanSecrets({ password: "123" });
    expect(result.found).toBe(true);
    expect(result.matches.some((m) => m.name === "forbidden_field")).toBe(true);
  });

  it("null / undefined / 数字 / 布尔不抛错", () => {
    expect(scanSecrets(null).found).toBe(false);
    expect(scanSecrets(undefined).found).toBe(false);
    expect(scanSecrets(42).found).toBe(false);
    expect(scanSecrets(true).found).toBe(false);
  });

  it("空对象不匹配", () => {
    expect(scanSecrets({}).found).toBe(false);
  });

  it("空数组不匹配", () => {
    expect(scanSecrets([]).found).toBe(false);
  });

  it("匹配结果不含原文 Secret", () => {
    const secret = "AKIAIOSFODNN7EXAMPLE";
    const result = scanSecrets(secret);
    const serialized = JSON.stringify(result);
    expect(serialized).not.toContain(secret);
  });
});
