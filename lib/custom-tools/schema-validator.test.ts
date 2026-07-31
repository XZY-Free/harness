import { describe, expect, it } from "vitest";
import { validateJsonSchema } from "./schema-validator";

/**
 * P1(01 AI Core P1-7 完整化):JSON Schema 子集校验器测试。
 * 覆盖 type/properties/required/additionalProperties/items/enum。
 */

describe("validateJsonSchema", () => {
  it("type 校验:object/string/number/boolean/array/null", () => {
    expect(validateJsonSchema({}, { type: "object" })).toEqual([]);
    expect(validateJsonSchema("x", { type: "string" })).toEqual([]);
    expect(validateJsonSchema(1, { type: "number" })).toEqual([]);
    expect(validateJsonSchema(true, { type: "boolean" })).toEqual([]);
    expect(validateJsonSchema([], { type: "array" })).toEqual([]);
    expect(validateJsonSchema(null, { type: "null" })).toEqual([]);
  });

  it("type 不符 → 报错", () => {
    const errs = validateJsonSchema("x", { type: "object" });
    expect(errs.length).toBe(1);
    expect(errs[0]).toContain("object");
  });

  it("integer 拒绝非整数", () => {
    expect(validateJsonSchema(1.5, { type: "integer" }).length).toBe(1);
    expect(validateJsonSchema(1, { type: "integer" })).toEqual([]);
  });

  it("properties 递归校验 + required 必填", () => {
    const schema = {
      type: "object",
      properties: {
        env: { type: "string" },
        count: { type: "number" },
      },
      required: ["env"],
    };
    expect(validateJsonSchema({ env: "prod", count: 3 }, schema)).toEqual([]);
    // 缺必填 env
    const errs1 = validateJsonSchema({ count: 3 }, schema);
    expect(errs1.some((e) => e.includes("env"))).toBe(true);
    // env 类型错
    const errs2 = validateJsonSchema({ env: 123 }, schema);
    expect(errs2.some((e) => e.includes("env") && e.includes("string"))).toBe(true);
  });

  it("additionalProperties:false 拒绝额外字段", () => {
    const schema = {
      type: "object",
      properties: { a: { type: "string" } },
      additionalProperties: false,
    };
    expect(validateJsonSchema({ a: "x" }, schema)).toEqual([]);
    const errs = validateJsonSchema({ a: "x", b: 1 }, schema);
    expect(errs.some((e) => e.includes("b"))).toBe(true);
  });

  it("additionalProperties 默认 true(允许额外字段)", () => {
    const schema = { type: "object", properties: { a: { type: "string" } } };
    expect(validateJsonSchema({ a: "x", b: 1 }, schema)).toEqual([]);
  });

  it("items 校验数组元素", () => {
    const schema = { type: "array", items: { type: "string" } };
    expect(validateJsonSchema(["a", "b"], schema)).toEqual([]);
    const errs = validateJsonSchema(["a", 1], schema);
    expect(errs.some((e) => e.includes("[1]"))).toBe(true);
  });

  it("enum 校验", () => {
    const schema = { enum: ["prod", "dev"] };
    expect(validateJsonSchema("prod", schema)).toEqual([]);
    expect(validateJsonSchema("staging", schema).length).toBe(1);
  });

  it("嵌套 object 递归校验(路径含 .)", () => {
    const schema = {
      type: "object",
      properties: {
        config: {
          type: "object",
          properties: { port: { type: "number" } },
          required: ["port"],
        },
      },
    };
    expect(validateJsonSchema({ config: { port: 8080 } }, schema)).toEqual([]);
    const errs = validateJsonSchema({ config: { port: "x" } }, schema);
    expect(errs.some((e) => e.includes("config.port"))).toBe(true);
  });

  it("V6-M3-2：不支持 keyword → fail-closed（报错而非静默跳过）", () => {
    // minLength/format 不在支持子集 → 应报错
    const schema = { type: "string", minLength: 5, format: "email" } as Record<string, unknown>;
    const errs = validateJsonSchema("ab", schema);
    expect(errs.length).toBeGreaterThanOrEqual(2); // minLength + format
    expect(errs.some((e) => e.includes("minLength"))).toBe(true);
    expect(errs.some((e) => e.includes("format"))).toBe(true);
  });

  it("V6-M3-2：$ref → 报错拒绝", () => {
    const schema = { $ref: "#/definitions/Foo" } as Record<string, unknown>;
    const errs = validateJsonSchema({}, schema);
    expect(errs.some((e) => e.includes("$ref"))).toBe(true);
  });

  it("V6-M3-2：oneOf/anyOf → 报错拒绝", () => {
    const errs1 = validateJsonSchema("x", { oneOf: [{ type: "string" }] } as Record<
      string,
      unknown
    >);
    expect(errs1.some((e) => e.includes("oneOf"))).toBe(true);
    const errs2 = validateJsonSchema("x", { anyOf: [{ type: "string" }] } as Record<
      string,
      unknown
    >);
    expect(errs2.some((e) => e.includes("anyOf"))).toBe(true);
  });

  it("V6-M3-2：支持的 keyword 仍正常校验（无不支持 keyword 报错）", () => {
    const schema = { type: "string" };
    expect(validateJsonSchema("hello", schema)).toEqual([]);
  });

  // ─── 审计修复：type 为数组 ───
  it('审计修复：type 为数组 ["string", "null"] 时 string 通过', () => {
    const schema = { type: ["string", "null"] };
    expect(validateJsonSchema("hello", schema)).toEqual([]);
    expect(validateJsonSchema(null, schema)).toEqual([]);
  });

  it("审计修复：type 为数组时不匹配的值报错", () => {
    const schema = { type: ["string", "null"] };
    const errs = validateJsonSchema(42, schema);
    expect(errs.length).toBe(1);
    expect(errs[0]).toContain("string|null");
  });

  it('审计修复：type 为数组 ["number", "boolean"] 时 number 和 boolean 通过', () => {
    const schema = { type: ["number", "boolean"] };
    expect(validateJsonSchema(3.14, schema)).toEqual([]);
    expect(validateJsonSchema(true, schema)).toEqual([]);
    expect(validateJsonSchema("hello", schema).length).toBe(1);
  });
});
