/**
 * S12-W05：V11 统一脱敏入口单元测试。
 *
 * 覆盖：
 * - registerV11SecretValues / getV11SecretValues / clearV11SecretValues / getAllV11SecretValues
 *   （进程内 Map，按 scope 注册 + 最小长度 4 过滤 + 幂等去重）
 * - redactForV11：
 *   - metadata 模式 → content=null
 *   - redacted / diagnostic 模式 → 三层组合脱敏（禁采字段名 + Secret 模式 + 已知明文值）
 *   - scope 参数（按 scope 查询明文值）
 *   - additionalKnownValues 参数（临时补充）
 *   - containsSecret 永远 false
 *   - redactionSummary 记录脱敏摘要
 * - redactForV11Legacy：兼容 content-policy.ts 的 redactContent
 */
import {
  clearV11SecretValues,
  getAllV11SecretValues,
  getV11SecretValues,
  redactForV11,
  redactForV11Legacy,
  registerV11SecretValues,
} from "@/lib/v11/security/unified-redaction";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

const TEST_SCOPE_A = "invocation-test-a";
const TEST_SCOPE_B = "invocation-test-b";

beforeEach(() => {
  // 每个测试前清理 secretStore，避免跨测试污染
  clearV11SecretValues(TEST_SCOPE_A);
  clearV11SecretValues(TEST_SCOPE_B);
});

afterEach(() => {
  clearV11SecretValues(TEST_SCOPE_A);
  clearV11SecretValues(TEST_SCOPE_B);
});

// ═══════════════════════════════════════════════════════════
// 1. 已知明文值注册（进程内 Map）
// ═══════════════════════════════════════════════════════════

describe("V11 registerV11SecretValues / getV11SecretValues", () => {
  it("注册后可按 scope 获取", () => {
    registerV11SecretValues(TEST_SCOPE_A, ["secret-one", "secret-two"]);
    expect(getV11SecretValues(TEST_SCOPE_A)).toEqual(
      expect.arrayContaining(["secret-one", "secret-two"]),
    );
  });

  it("未注册的 scope 返回空数组", () => {
    expect(getV11SecretValues("non-existent-scope")).toEqual([]);
  });

  it("长度 < 4 的值被跳过（防误伤）", () => {
    registerV11SecretValues(TEST_SCOPE_A, ["abc", "abcd", "ab"]);
    const values = getV11SecretValues(TEST_SCOPE_A);
    expect(values).toEqual(["abcd"]);
  });

  it("空字符串与 null/undefined 被跳过", () => {
    registerV11SecretValues(TEST_SCOPE_A, ["", "valid-secret"]);
    const values = getV11SecretValues(TEST_SCOPE_A);
    expect(values).toEqual(["valid-secret"]);
  });

  it("重复注册去重（Set 语义）", () => {
    registerV11SecretValues(TEST_SCOPE_A, ["secret-one"]);
    registerV11SecretValues(TEST_SCOPE_A, ["secret-one", "secret-two"]);
    const values = getV11SecretValues(TEST_SCOPE_A);
    expect(values.length).toBe(2);
    expect(values).toEqual(expect.arrayContaining(["secret-one", "secret-two"]));
  });

  it("不同 scope 互不影响", () => {
    registerV11SecretValues(TEST_SCOPE_A, ["scope-a-secret"]);
    registerV11SecretValues(TEST_SCOPE_B, ["scope-b-secret"]);
    expect(getV11SecretValues(TEST_SCOPE_A)).toEqual(["scope-a-secret"]);
    expect(getV11SecretValues(TEST_SCOPE_B)).toEqual(["scope-b-secret"]);
  });

  it("空数组注册无副作用", () => {
    registerV11SecretValues(TEST_SCOPE_A, []);
    expect(getV11SecretValues(TEST_SCOPE_A)).toEqual([]);
  });
});

// ═══════════════════════════════════════════════════════════
// 2. clearV11SecretValues
// ═══════════════════════════════════════════════════════════

describe("V11 clearV11SecretValues", () => {
  it("清除指定 scope 的注册值", () => {
    registerV11SecretValues(TEST_SCOPE_A, ["secret-one"]);
    clearV11SecretValues(TEST_SCOPE_A);
    expect(getV11SecretValues(TEST_SCOPE_A)).toEqual([]);
  });

  it("清除一个 scope 不影响其他 scope", () => {
    registerV11SecretValues(TEST_SCOPE_A, ["scope-a-secret"]);
    registerV11SecretValues(TEST_SCOPE_B, ["scope-b-secret"]);
    clearV11SecretValues(TEST_SCOPE_A);
    expect(getV11SecretValues(TEST_SCOPE_A)).toEqual([]);
    expect(getV11SecretValues(TEST_SCOPE_B)).toEqual(["scope-b-secret"]);
  });

  it("清除不存在的 scope 不抛错", () => {
    expect(() => clearV11SecretValues("non-existent-scope")).not.toThrow();
  });
});

// ═══════════════════════════════════════════════════════════
// 3. getAllV11SecretValues
// ═══════════════════════════════════════════════════════════

describe("V11 getAllV11SecretValues", () => {
  it("聚合所有 scope 的明文值", () => {
    registerV11SecretValues(TEST_SCOPE_A, ["secret-a"]);
    registerV11SecretValues(TEST_SCOPE_B, ["secret-b"]);
    const all = getAllV11SecretValues();
    expect(all).toEqual(expect.arrayContaining(["secret-a", "secret-b"]));
  });

  it("无注册时返回空数组", () => {
    clearV11SecretValues(TEST_SCOPE_A);
    clearV11SecretValues(TEST_SCOPE_B);
    // 注意：可能存在其他测试注册的值，但本测试 scope 已清理
    const all = getAllV11SecretValues();
    expect(all).not.toContain("secret-a");
    expect(all).not.toContain("secret-b");
  });
});

// ═══════════════════════════════════════════════════════════
// 4. redactForV11：metadata 模式
// ═══════════════════════════════════════════════════════════

describe("V11 redactForV11 metadata 模式", () => {
  it("返回 content=null", () => {
    const result = redactForV11({ data: "anything" }, "metadata");
    expect(result.content).toBeNull();
  });

  it("containsSecret 永远 false", () => {
    const result = redactForV11({ password: "AKIAIOSFODNN7EXAMPLE" }, "metadata");
    expect(result.containsSecret).toBe(false);
  });

  it("redactionSummary 为 metadata-only", () => {
    const result = redactForV11("anything", "metadata");
    expect(result.redactionSummary).toBe("metadata-only");
  });

  it("null 输入也返回 null content", () => {
    const result = redactForV11(null, "metadata");
    expect(result.content).toBeNull();
  });
});

// ═══════════════════════════════════════════════════════════
// 5. redactForV11：redacted / diagnostic 模式（三层组合脱敏）
// ═══════════════════════════════════════════════════════════

describe("V11 redactForV11 redacted 模式", () => {
  it("无 Secret 的内容原样返回", () => {
    const value = { name: "user", age: 30 };
    const result = redactForV11(value, "redacted");
    expect(result.content).toEqual(value);
    expect(result.containsSecret).toBe(false);
    expect(result.redactionSummary).toBeNull();
  });

  it("第一层：禁采字段名脱敏", () => {
    const value = { password: "123456", name: "user" };
    const result = redactForV11(value, "redacted");
    const content = result.content as Record<string, unknown>;
    expect(content.password).toBe("[REDACTED]");
    expect(content.name).toBe("user");
    expect(result.containsSecret).toBe(false);
    expect(result.redactionSummary).toContain("redacted");
  });

  it("第二层：Secret 模式脱敏（AWS Access Key）", () => {
    const value = { description: "key: AKIAIOSFODNN7EXAMPLE end" };
    const result = redactForV11(value, "redacted");
    const content = result.content as Record<string, unknown>;
    expect(content.description).toBe("key: [REDACTED:aws_access_key_id] end");
  });

  it("第二层：Secret 模式脱敏（GitHub Token）", () => {
    const value = "token ghp_0123456789abcdefghijklmnopqrstuvwxyz";
    const result = redactForV11(value, "redacted");
    expect(result.content).toBe("token [REDACTED:github_token]");
  });

  it("第三层：已知明文值脱敏（按 scope）", () => {
    registerV11SecretValues(TEST_SCOPE_A, ["my-secret-value"]);
    const value = { description: "contains my-secret-value here" };
    const result = redactForV11(value, "redacted", { scope: TEST_SCOPE_A });
    const content = result.content as Record<string, unknown>;
    expect(content.description).toBe("contains [REDACTED] here");
  });

  it("第三层：additionalKnownValues 临时补充", () => {
    const value = { description: "contains temp-secret here" };
    const result = redactForV11(value, "redacted", {
      additionalKnownValues: ["temp-secret"],
    });
    const content = result.content as Record<string, unknown>;
    expect(content.description).toBe("contains [REDACTED] here");
  });

  it("三层组合脱敏同时生效", () => {
    registerV11SecretValues(TEST_SCOPE_A, ["my-secret-value"]);
    const value = {
      password: "123456",
      description: "key: AKIAIOSFODNN7EXAMPLE",
      note: "contains my-secret-value here",
      name: "user",
    };
    const result = redactForV11(value, "redacted", { scope: TEST_SCOPE_A });
    const content = result.content as Record<string, unknown>;
    expect(content.password).toBe("[REDACTED]");
    expect(content.description).toBe("key: [REDACTED:aws_access_key_id]");
    expect(content.note).toBe("contains [REDACTED] here");
    expect(content.name).toBe("user");
    expect(result.containsSecret).toBe(false);
  });

  it("不传 scope 时扫描所有注册值", () => {
    registerV11SecretValues(TEST_SCOPE_A, ["scope-a-secret"]);
    registerV11SecretValues(TEST_SCOPE_B, ["scope-b-secret"]);
    const value = "scope-a-secret scope-b-secret";
    const result = redactForV11(value, "redacted");
    expect(result.content).toBe("[REDACTED] [REDACTED]");
  });

  it("递归脱敏嵌套对象", () => {
    const value = {
      outer: {
        password: "secret",
        description: "AKIAIOSFODNN7EXAMPLE",
      },
    };
    const result = redactForV11(value, "redacted");
    const content = result.content as Record<string, unknown>;
    const outer = content.outer as Record<string, unknown>;
    expect(outer.password).toBe("[REDACTED]");
    expect(outer.description).toBe("[REDACTED:aws_access_key_id]");
  });

  it("递归脱白数组", () => {
    const value = ["AKIAIOSFODNN7EXAMPLE", "plain"];
    const result = redactForV11(value, "redacted");
    expect(result.content).toEqual(["[REDACTED:aws_access_key_id]", "plain"]);
  });

  it("字符串中多个 Secret 全部脱敏", () => {
    const value = "aws=AKIAIOSFODNN7EXAMPLE github=ghp_0123456789abcdefghijklmnopqrstuvwxyz";
    const result = redactForV11(value, "redacted");
    expect(result.content).toBe("aws=[REDACTED:aws_access_key_id] github=[REDACTED:github_token]");
  });

  it("脱敏后结果不含原文 Secret", () => {
    const secret = "AKIAIOSFODNN7EXAMPLE";
    const result = redactForV11(`key: ${secret}`, "redacted");
    const serialized = JSON.stringify(result);
    expect(serialized).not.toContain(secret);
  });
});

// ═══════════════════════════════════════════════════════════
// 6. redactForV11：diagnostic 模式（与 redacted 行为一致）
// ═══════════════════════════════════════════════════════════

describe("V11 redactForV11 diagnostic 模式", () => {
  it("禁采字段脱敏（与 redacted 一致）", () => {
    const value = { password: "123", name: "user" };
    const result = redactForV11(value, "diagnostic");
    const content = result.content as Record<string, unknown>;
    expect(content.password).toBe("[REDACTED]");
    expect(content.name).toBe("user");
  });

  it("Secret 模式脱敏（与 redacted 一致）", () => {
    const value = "AKIAIOSFODNN7EXAMPLE";
    const result = redactForV11(value, "diagnostic");
    expect(result.content).toBe("[REDACTED:aws_access_key_id]");
  });

  it("已知明文值脱敏（与 redacted 一致）", () => {
    registerV11SecretValues(TEST_SCOPE_A, ["my-secret-value"]);
    const result = redactForV11("my-secret-value", "diagnostic", {
      scope: TEST_SCOPE_A,
    });
    expect(result.content).toBe("[REDACTED]");
  });

  it("redactionSummary 包含 mode=diagnostic", () => {
    const result = redactForV11({ password: "x" }, "diagnostic");
    expect(result.redactionSummary).toContain("diagnostic");
  });
});

// ═══════════════════════════════════════════════════════════
// 7. redactForV11：边界情况
// ═══════════════════════════════════════════════════════════

describe("V11 redactForV11 边界情况", () => {
  it("null 输入原样返回（redacted 模式）", () => {
    const result = redactForV11(null, "redacted");
    expect(result.content).toBeNull();
    expect(result.containsSecret).toBe(false);
    expect(result.redactionSummary).toBeNull();
  });

  it("undefined 输入原样返回", () => {
    const result = redactForV11(undefined, "redacted");
    expect(result.content).toBeUndefined();
    expect(result.containsSecret).toBe(false);
  });

  it("数字输入原样返回", () => {
    const result = redactForV11(42, "redacted");
    expect(result.content).toBe(42);
  });

  it("布尔输入原样返回", () => {
    const result = redactForV11(true, "redacted");
    expect(result.content).toBe(true);
  });

  it("空字符串原样返回", () => {
    const result = redactForV11("", "redacted");
    expect(result.content).toBe("");
  });

  it("空对象原样返回", () => {
    const result = redactForV11({}, "redacted");
    expect(result.content).toEqual({});
    expect(result.redactionSummary).toBeNull();
  });

  it("空数组原样返回", () => {
    const result = redactForV11([], "redacted");
    expect(result.content).toEqual([]);
  });

  it("普通字符串不含 Secret 时原样返回", () => {
    const result = redactForV11("hello world", "redacted");
    expect(result.content).toBe("hello world");
    expect(result.redactionSummary).toBeNull();
  });

  it("scope 与 additionalKnownValues 同时生效", () => {
    registerV11SecretValues(TEST_SCOPE_A, ["scope-secret"]);
    const value = "scope-secret temp-secret";
    const result = redactForV11(value, "redacted", {
      scope: TEST_SCOPE_A,
      additionalKnownValues: ["temp-secret"],
    });
    expect(result.content).toBe("[REDACTED] [REDACTED]");
  });
});

// ═══════════════════════════════════════════════════════════
// 8. redactForV11Legacy
// ═══════════════════════════════════════════════════════════

describe("V11 redactForV11Legacy", () => {
  it("metadata 模式返回 null content", () => {
    const result = redactForV11Legacy({ data: "x" }, "metadata");
    expect(result.content).toBeNull();
    expect(result.redactionSummary).toBe("metadata-only");
  });

  it("redacted 模式脱敏禁采字段", () => {
    const result = redactForV11Legacy({ password: "123" }, "redacted");
    const content = result.content as Record<string, unknown>;
    expect(content.password).toBe("[REDACTED]");
    expect(result.containsSecret).toBe(false);
  });

  it("无 Secret 时原样返回", () => {
    const value = { name: "user" };
    const result = redactForV11Legacy(value, "redacted");
    expect(result.content).toEqual(value);
    expect(result.redactionSummary).toBeNull();
  });
});
