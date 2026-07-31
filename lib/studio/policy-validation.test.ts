import { defaultPolicyRows } from "@/lib/policy/config";
import { PolicyValidationError, validatePolicyRows } from "@/lib/studio/policy-validation";
import { describe, expect, it } from "vitest";

/**
 * Stage C1：policy payload 白名单 + shape + regex + timeout 校验测试。
 */

function rows() {
  return defaultPolicyRows();
}

/** 取 input 中指定 key 的行（缺失则抛错，避免 non-null assertion）。 */
function row(input: { key: string; value: unknown }[], key: string) {
  const r = input.find((x) => x.key === key);
  if (!r) throw new Error(`missing row: ${key}`);
  return r;
}

describe("validatePolicyRows — 通过路径", () => {
  it("defaultPolicyRows 通过并返回规范化 4 行", () => {
    const out = validatePolicyRows(rows());
    expect(out).toHaveLength(4);
    expect(out.map((r) => r.key)).toEqual([
      "protectedPaths",
      "commandDenyList",
      "formatOnWrite",
      "verifyBeforeDelivery",
    ]);
    const verify = out.find((r) => r.key === "verifyBeforeDelivery");
    expect(verify?.value).toMatchObject({
      enabled: true,
      command: "npm test",
      timeoutMs: 60_000,
      timeoutIsFailure: false,
    });
  });

  it("未知对象字段被丢弃，返回 normalized rows", () => {
    const input = rows().map((r) => ({ ...r }));
    const fow = input.find((r) => r.key === "formatOnWrite") as {
      value: Record<string, unknown>;
    };
    fow.value = { ...fow.value, extra: "drop-me" };
    const out = validatePolicyRows(input);
    const fowOut = out.find((r) => r.key === "formatOnWrite");
    expect(fowOut?.value).not.toHaveProperty("extra");
    expect(fowOut?.value).toEqual({ enabled: true, command: "npx --no-install prettier --write" });
  });

  it("空 command 允许（formatOnWrite no-op）", () => {
    const input = rows();
    const fow = input.find((r) => r.key === "formatOnWrite") as {
      value: Record<string, unknown>;
    };
    fow.value = { enabled: true, command: "" };
    expect(() => validatePolicyRows(input)).not.toThrow();
  });

  it("空数组 protectedPaths 允许", () => {
    const input = rows();
    const pp = row(input, "protectedPaths");
    pp.value = [];
    const out = validatePolicyRows(input);
    expect(out.find((r) => r.key === "protectedPaths")?.value).toEqual([]);
  });
});

describe("validatePolicyRows — key 白名单", () => {
  it("未知 key → invalid_policy", () => {
    const input = [...rows(), { key: "evil", value: "x" }];
    expect(() => validatePolicyRows(input)).toThrow(PolicyValidationError);
    expect(() => validatePolicyRows(input)).toThrow(/未知 policy key/);
  });

  it("缺少 key → invalid_policy", () => {
    const input = rows().filter((r) => r.key !== "formatOnWrite");
    expect(() => validatePolicyRows(input)).toThrow(/缺少 policy key/);
  });

  it("重复 key → invalid_policy", () => {
    const input = [...rows(), { key: "formatOnWrite", value: { enabled: false, command: "" } }];
    expect(() => validatePolicyRows(input)).toThrow(/重复 policy key/);
  });

  it("非数组输入 → invalid_policy", () => {
    expect(() => validatePolicyRows({})).toThrow(/rows 必须是数组/);
    expect(() => validatePolicyRows(null)).toThrow(/rows 必须是数组/);
  });

  it("行不是 { key, value } → invalid_policy", () => {
    expect(() => validatePolicyRows(["x"])).toThrow(/每行必须是/);
  });
});

describe("validatePolicyRows — shape / regex / timeout", () => {
  it("protectedPaths 含非法正则 → invalid_policy", () => {
    const input = rows();
    row(input, "protectedPaths").value = ["["];
    expect(() => validatePolicyRows(input)).toThrow(/非法正则/);
  });

  it("protectedPaths 含空项 → invalid_policy", () => {
    const input = rows();
    row(input, "protectedPaths").value = [""];
    expect(() => validatePolicyRows(input)).toThrow(/不能为空/);
  });

  it("protectedPaths 含非字符串 → invalid_policy", () => {
    const input = rows();
    row(input, "protectedPaths").value = [123];
    expect(() => validatePolicyRows(input)).toThrow(/每项必须是字符串/);
  });

  it("commandDenyList 不是数组 → invalid_policy", () => {
    const input = rows();
    row(input, "commandDenyList").value = "rm";
    expect(() => validatePolicyRows(input)).toThrow(/必须是数组/);
  });

  it("数组长度超过 50 → invalid_policy", () => {
    const input = rows();
    row(input, "protectedPaths").value = Array.from({ length: 51 }, () => "^a$");
    expect(() => validatePolicyRows(input)).toThrow(/长度超过 50/);
  });

  it("formatOnWrite.enabled 非 boolean → invalid_policy", () => {
    const input = rows();
    row(input, "formatOnWrite").value = { enabled: "yes", command: "" };
    expect(() => validatePolicyRows(input)).toThrow(/enabled 必须/);
  });

  it("formatOnWrite.command 含 NUL → invalid_policy", () => {
    const input = rows();
    row(input, "formatOnWrite").value = { enabled: true, command: "x\0y" };
    expect(() => validatePolicyRows(input)).toThrow(/NUL/);
  });

  it("verifyBeforeDelivery.timeoutMs 越界（过小）→ invalid_policy", () => {
    const input = rows();
    const v = row(input, "verifyBeforeDelivery").value as Record<string, unknown>;
    v.timeoutMs = 500;
    expect(() => validatePolicyRows(input)).toThrow(/timeoutMs/);
  });

  it("verifyBeforeDelivery.timeoutMs 越界（过大）→ invalid_policy", () => {
    const input = rows();
    const v = row(input, "verifyBeforeDelivery").value as Record<string, unknown>;
    v.timeoutMs = 300_001;
    expect(() => validatePolicyRows(input)).toThrow(/timeoutMs/);
  });

  it("verifyBeforeDelivery.timeoutMs 非整数 → invalid_policy", () => {
    const input = rows();
    const v = row(input, "verifyBeforeDelivery").value as Record<string, unknown>;
    v.timeoutMs = 10_000.5;
    expect(() => validatePolicyRows(input)).toThrow(/timeoutMs/);
  });

  it("verifyBeforeDelivery.timeoutIsFailure 非 boolean → invalid_policy", () => {
    const input = rows();
    const v = row(input, "verifyBeforeDelivery").value as Record<string, unknown>;
    v.timeoutIsFailure = "yes";
    expect(() => validatePolicyRows(input)).toThrow(/timeoutIsFailure/);
  });

  it("verifyBeforeDelivery.testFilePattern 非法正则 → invalid_policy", () => {
    const input = rows();
    const v = row(input, "verifyBeforeDelivery").value as Record<string, unknown>;
    v.testFilePattern = "(unclosed";
    expect(() => validatePolicyRows(input)).toThrow(/非法正则/);
  });

  it("verifyBeforeDelivery 不是对象 → invalid_policy", () => {
    const input = rows();
    row(input, "verifyBeforeDelivery").value = [];
    expect(() => validatePolicyRows(input)).toThrow(/必须是对象/);
  });
});

describe("PolicyValidationError", () => {
  it("code 固定为 invalid_policy", () => {
    const e = new PolicyValidationError("x");
    expect(e.code).toBe("invalid_policy");
    expect(e.message).toBe("x");
    expect(e).toBeInstanceOf(Error);
  });
});
