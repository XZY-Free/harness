/**
 * P1 修复（01 AI Core 完整化）：轻量 JSON Schema 子集校验器。
 *
 * 审计建议"用 zod 从 decl.inputSchema 编译(或 ajv)校验 args 结构"。zod v4 无
 * fromJSONSchema(不支持反向编译),ajv 需引重依赖(违反不引重依赖原则)。
 * 本模块实现 JSON Schema 核心子集校验,覆盖 custom tool 声明的常见需求,不引依赖。
 *
 * 支持的 JSON Schema 子集:
 * - type: object | array | string | number | integer | boolean | null
 * - properties: 对象属性按子 schema 递归校验
 * - required: 必填字段(数组)
 * - additionalProperties: false 时拒绝额外字段(默认 true 允许)
 * - items: 数组元素按子 schema 校验
 * - enum: 值在枚举内
 *
 * fail-closed：遇不支持的 keyword（$ref/oneOf/anyOf/pattern/format/minLength/maxLength）
 * 报错而非静默跳过。坏 schema 被拒绝，迫使 custom tool 声明者简化 schema 到支持子集。
 *
 * @returns 空数组校验通过;否则错误描述数组(供调用方拼接)
 */

type JsonSchema = Record<string, unknown>;

const TYPE_CHECKERS: Record<string, (v: unknown) => boolean> = {
  object: (v) => typeof v === "object" && v !== null && !Array.isArray(v),
  array: (v) => Array.isArray(v),
  string: (v) => typeof v === "string",
  number: (v) => typeof v === "number" && Number.isFinite(v),
  integer: (v) => typeof v === "number" && Number.isInteger(v),
  boolean: (v) => typeof v === "boolean",
  null: (v) => v === null,
};

/** 不支持的 JSON Schema keyword，遇则报错（fail-closed）。 */
const UNSUPPORTED_KEYWORDS = [
  "$ref",
  "oneOf",
  "anyOf",
  "allOf",
  "pattern",
  "format",
  "minLength",
  "maxLength",
  "minimum",
  "maximum",
  "patternProperties",
  "const",
];

/**
 * 校验 value 是否符合 schema。返回错误列表(空=通过)。
 * 递归校验 properties/items,深度受 validateCustomArgs 的 maxDepth 兜底保护。
 */
export function validateJsonSchema(value: unknown, schema: JsonSchema, path = ""): string[] {
  const errors: string[] = [];

  // 不支持的 keyword → fail-closed（报错而非静默跳过）
  for (const kw of UNSUPPORTED_KEYWORDS) {
    if (kw in schema) {
      errors.push(`${path || "schema"} 含不支持的 JSON Schema keyword "${kw}"，请简化 schema`);
    }
  }

  // type 校验
  const type = schema.type;
  if (typeof type === "string") {
    const checker = TYPE_CHECKERS[type];
    if (checker && !checker(value)) {
      errors.push(
        `${path || "value"} 应为 ${type},实际 ${Array.isArray(value) ? "array" : typeof value}`,
      );
      return errors; // 类型不符,子校验无意义
    }
  } else if (Array.isArray(type)) {
    // 审计修复：JSON Schema 允许 type 为数组（如 ["string", "null"]），原实现静默跳过。
    // 现逐项检查，value 至少匹配其中一个类型才通过。
    const matched = (type as unknown[]).some((t) => {
      if (typeof t !== "string") return false;
      const checker = TYPE_CHECKERS[t];
      return checker ? checker(value) : false;
    });
    if (!matched) {
      errors.push(
        `${path || "value"} 应为 ${(type as string[]).join("|")} 之一,实际 ${Array.isArray(value) ? "array" : typeof value}`,
      );
      return errors;
    }
  }

  // enum 校验
  if (Array.isArray(schema.enum) && !schema.enum.includes(value)) {
    errors.push(`${path || "value"} 不在枚举 ${JSON.stringify(schema.enum)} 内`);
  }

  // object: properties + required + additionalProperties
  if (
    typeof value === "object" &&
    value !== null &&
    !Array.isArray(value) &&
    typeof schema.properties === "object" &&
    schema.properties !== null
  ) {
    const props = schema.properties as Record<string, JsonSchema>;
    const required = Array.isArray(schema.required) ? (schema.required as string[]) : [];

    // required 校验
    for (const key of required) {
      if (!(key in value)) {
        errors.push(`${path || "object"} 缺少必填字段 ${key}`);
      }
    }

    // properties 递归校验
    for (const [key, subSchema] of Object.entries(props)) {
      if (key in value) {
        const subErrors = validateJsonSchema(
          (value as Record<string, unknown>)[key],
          subSchema,
          path ? `${path}.${key}` : key,
        );
        errors.push(...subErrors);
      }
    }

    // additionalProperties: false 时拒绝额外字段
    if (schema.additionalProperties === false) {
      const allowed = new Set(Object.keys(props));
      for (const key of Object.keys(value)) {
        if (!allowed.has(key)) {
          errors.push(`${path || "object"} 含未声明字段 ${key}(additionalProperties:false)`);
        }
      }
    }
  }

  // array: items 校验
  if (Array.isArray(value) && typeof schema.items === "object" && schema.items !== null) {
    const itemSchema = schema.items as JsonSchema;
    for (let i = 0; i < value.length; i++) {
      const subErrors = validateJsonSchema(value[i], itemSchema, `${path || "array"}[${i}]`);
      errors.push(...subErrors);
    }
  }

  return errors;
}
