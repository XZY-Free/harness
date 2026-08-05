/**
 * RFC 8785 JSON Canonicalization 单元测试。
 */

import { describe, expect, it } from "vitest";
import { computeCanonicalDigest, rfc8785Canonicalize } from "./rfc-8785-canonicalize";

describe("rfc8785Canonicalize", () => {
  it("null → 'null'", () => {
    expect(rfc8785Canonicalize(null)).toBe("null");
  });

  it("true → 'true'", () => {
    expect(rfc8785Canonicalize(true)).toBe("true");
  });

  it("false → 'false'", () => {
    expect(rfc8785Canonicalize(false)).toBe("false");
  });

  it("number: 0 → '0'", () => {
    expect(rfc8785Canonicalize(0)).toBe("0");
  });

  it("number: -0 → '0' (not '-0')", () => {
    expect(rfc8785Canonicalize(-0)).toBe("0");
  });

  it("number: 1 → '1'", () => {
    expect(rfc8785Canonicalize(1)).toBe("1");
  });

  it("number: 1e20 → ES6 serialization", () => {
    expect(rfc8785Canonicalize(1e20)).toBe("100000000000000000000");
  });

  it("number: NaN → TypeError", () => {
    expect(() => rfc8785Canonicalize(Number.NaN)).toThrow(TypeError);
  });

  it("number: Infinity → TypeError", () => {
    expect(() => rfc8785Canonicalize(Number.POSITIVE_INFINITY)).toThrow(TypeError);
  });

  it("number: -Infinity → TypeError", () => {
    expect(() => rfc8785Canonicalize(Number.NEGATIVE_INFINITY)).toThrow(TypeError);
  });

  it("undefined → TypeError", () => {
    expect(() => rfc8785Canonicalize(undefined)).toThrow(TypeError);
  });

  it("string: empty → '\"\"'", () => {
    expect(rfc8785Canonicalize("")).toBe('""');
  });

  it("string: hello → '\"hello\"'", () => {
    expect(rfc8785Canonicalize("hello")).toBe('"hello"');
  });

  it("string: escapes necessary chars", () => {
    expect(rfc8785Canonicalize('a"b')).toBe('"a\\"b"');
  });

  it("empty array → '[]'", () => {
    expect(rfc8785Canonicalize([])).toBe("[]");
  });

  it("array [1,2,3] → '[1,2,3]'", () => {
    expect(rfc8785Canonicalize([1, 2, 3])).toBe("[1,2,3]");
  });

  it("empty object → '{}'", () => {
    expect(rfc8785Canonicalize({})).toBe("{}");
  });

  it("object keys sorted by UTF-16 code unit", () => {
    expect(rfc8785Canonicalize({ b: 2, a: 1 })).toBe('{"a":1,"b":2}');
  });

  it("nested object", () => {
    const result = rfc8785Canonicalize({ inner: { z: 1, a: 2 } });
    expect(result).toBe('{"inner":{"a":2,"z":1}}');
  });

  it("deterministic output — same input same result", () => {
    const input = { c: 3, a: 1, b: 2, nested: { z: 0, m: 1 } };
    const r1 = rfc8785Canonicalize(input);
    const r2 = rfc8785Canonicalize(input);
    expect(r1).toBe(r2);
  });

  it("circular reference → TypeError", () => {
    const obj: Record<string, unknown> = {};
    obj.self = obj;
    expect(() => rfc8785Canonicalize(obj)).toThrow(TypeError);
  });
});

describe("computeCanonicalDigest", () => {
  it("returns sha256: prefixed hex", () => {
    const result = computeCanonicalDigest({ a: 1 });
    expect(result).toMatch(/^sha256:[0-9a-f]{64}$/);
  });

  it("same input → same digest", () => {
    const d1 = computeCanonicalDigest({ b: 2, a: 1 });
    const d2 = computeCanonicalDigest({ a: 1, b: 2 });
    expect(d1).toBe(d2);
  });

  it("different input → different digest", () => {
    const d1 = computeCanonicalDigest({ a: 1 });
    const d2 = computeCanonicalDigest({ a: 2 });
    expect(d1).not.toBe(d2);
  });
});
