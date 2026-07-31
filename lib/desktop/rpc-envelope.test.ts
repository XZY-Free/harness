import {
  type RpcRequestEnvelope,
  type RpcResultEnvelope,
  canonicalSerialize,
  getEnvelopeSignPayload,
  getResultSignPayload,
  rpcRequestEnvelopeSchema,
  rpcResultEnvelopeSchema,
} from "@/lib/desktop/rpc-envelope";
import { describe, expect, it } from "vitest";

/** 构造合法请求信封 */
function makeValidRequestEnvelope(): RpcRequestEnvelope {
  return {
    protocolVersion: 1,
    requestId: "req-001",
    deviceId: "dev-001",
    userId: "user-001",
    threadId: "thread-001",
    tabId: null,
    runId: null,
    approvalId: null,
    command: "browser.getTabs",
    payload: { threadId: "thread-001" },
    issuedAt: 1700000000000,
    expiresAt: 1700000060000,
    nonce: "nonce-001",
    signature: "sig-001",
  };
}

/** 构造合法结果信封 */
function makeValidResultEnvelope(): RpcResultEnvelope {
  return {
    requestId: "req-001",
    deviceId: "dev-001",
    ok: true,
    result: { tabs: [] },
    error: null,
    timestamp: 1700000001000,
    signature: "sig-001",
  };
}

describe("rpcRequestEnvelopeSchema", () => {
  it("合法信封通过", () => {
    const env = makeValidRequestEnvelope();
    expect(rpcRequestEnvelopeSchema.safeParse(env).success).toBe(true);
  });

  it("缺少字段拒绝", () => {
    const env = makeValidRequestEnvelope();
    const { requestId, ...rest } = env;
    void requestId;
    expect(rpcRequestEnvelopeSchema.safeParse(rest).success).toBe(false);
  });

  it("protocolVersion 非正整数拒绝", () => {
    const env = makeValidRequestEnvelope();
    expect(rpcRequestEnvelopeSchema.safeParse({ ...env, protocolVersion: -1 }).success).toBe(false);
    expect(rpcRequestEnvelopeSchema.safeParse({ ...env, protocolVersion: 0 }).success).toBe(false);
  });

  it("command 为空字符串拒绝", () => {
    const env = makeValidRequestEnvelope();
    expect(rpcRequestEnvelopeSchema.safeParse({ ...env, command: "" }).success).toBe(false);
  });

  it("tabId 为 null 通过", () => {
    const env = makeValidRequestEnvelope();
    env.tabId = null;
    expect(rpcRequestEnvelopeSchema.safeParse(env).success).toBe(true);
  });

  it("tabId 为字符串通过", () => {
    const env = makeValidRequestEnvelope();
    env.tabId = "tab-001";
    expect(rpcRequestEnvelopeSchema.safeParse(env).success).toBe(true);
  });

  it("signature 为空字符串拒绝", () => {
    const env = makeValidRequestEnvelope();
    expect(rpcRequestEnvelopeSchema.safeParse({ ...env, signature: "" }).success).toBe(false);
  });
});

describe("rpcResultEnvelopeSchema", () => {
  it("合法信封（成功结果）通过", () => {
    const env = makeValidResultEnvelope();
    expect(rpcResultEnvelopeSchema.safeParse(env).success).toBe(true);
  });

  it("合法信封（错误结果）通过", () => {
    const env: RpcResultEnvelope = {
      requestId: "req-001",
      deviceId: "dev-001",
      ok: false,
      result: null,
      error: { code: "browser_internal", message: "失败", detail: null },
      timestamp: 1700000001000,
      signature: "sig-001",
    };
    expect(rpcResultEnvelopeSchema.safeParse(env).success).toBe(true);
  });

  it("缺少 signature 拒绝", () => {
    const env = makeValidResultEnvelope();
    const { signature, ...rest } = env;
    void signature;
    expect(rpcResultEnvelopeSchema.safeParse(rest).success).toBe(false);
  });

  it("ok 非 boolean 拒绝", () => {
    const env = makeValidResultEnvelope();
    expect(rpcResultEnvelopeSchema.safeParse({ ...env, ok: "true" }).success).toBe(false);
  });
});

describe("canonicalSerialize()", () => {
  it("字段按字母序排列", () => {
    const data = { b: 2, a: 1, c: 3 };
    const result = canonicalSerialize(data);
    // 字母序：a, b, c
    expect(result).toBe('{"a":1,"b":2,"c":3}');
  });

  it("嵌套对象递归排序", () => {
    const data = { outer: { z: 1, a: 2 }, first: 1 };
    const result = canonicalSerialize(data);
    // 外层 first, outer；内层 a, z
    expect(result).toBe('{"first":1,"outer":{"a":2,"z":1}}');
  });

  it("数组保持顺序", () => {
    const data = {
      arr: [
        { z: 1, a: 2 },
        { b: 3, a: 4 },
      ],
    };
    const result = canonicalSerialize(data);
    // 数组元素保持顺序，但对象内字段排序
    expect(result).toBe('{"arr":[{"a":2,"z":1},{"a":4,"b":3}]}');
  });

  it("同一对象多次序列化结果一致（确定性）", () => {
    const data = { c: 3, a: 1, b: { z: 2, y: 1 } };
    const r1 = canonicalSerialize(data);
    const r2 = canonicalSerialize(data);
    expect(r1).toBe(r2);
  });

  it("不同顺序输入产生相同输出", () => {
    const data1 = { a: 1, b: 2, c: 3 };
    const data2 = { c: 3, b: 2, a: 1 };
    expect(canonicalSerialize(data1)).toBe(canonicalSerialize(data2));
  });

  it("空对象", () => {
    expect(canonicalSerialize({})).toBe("{}");
  });

  it("包含 null 值", () => {
    const data = { a: null, b: 1 };
    expect(canonicalSerialize(data)).toBe('{"a":null,"b":1}');
  });
});

describe("getEnvelopeSignPayload()", () => {
  it("排除 signature 字段", () => {
    const env = makeValidRequestEnvelope();
    const payload = getEnvelopeSignPayload(env);
    expect(payload).not.toContain("signature");
    expect(payload).not.toContain('"sig-001"');
  });

  it("字段按字母序排列", () => {
    const env = makeValidRequestEnvelope();
    const payload = getEnvelopeSignPayload(env);
    // 第一个字段应该是 approvalId（字母序最前）
    expect(payload.startsWith('{"approvalId"')).toBe(true);
  });

  it("同一信封多次调用结果一致", () => {
    const env = makeValidRequestEnvelope();
    const r1 = getEnvelopeSignPayload(env);
    const r2 = getEnvelopeSignPayload(env);
    expect(r1).toBe(r2);
  });

  it("signature 值改变不影响 payload", () => {
    const env1 = makeValidRequestEnvelope();
    const env2 = { ...env1, signature: "different-sig" };
    expect(getEnvelopeSignPayload(env1)).toBe(getEnvelopeSignPayload(env2));
  });
});

describe("getResultSignPayload()", () => {
  it("排除 signature 字段", () => {
    const env = makeValidResultEnvelope();
    const payload = getResultSignPayload(env);
    expect(payload).not.toContain("signature");
    expect(payload).not.toContain('"sig-001"');
  });

  it("字段按字母序排列", () => {
    const env = makeValidResultEnvelope();
    const payload = getResultSignPayload(env);
    // 第一个字段应该是 deviceId（字母序最前）
    expect(payload.startsWith('{"deviceId"')).toBe(true);
  });

  it("同一信封多次调用结果一致", () => {
    const env = makeValidResultEnvelope();
    const r1 = getResultSignPayload(env);
    const r2 = getResultSignPayload(env);
    expect(r1).toBe(r2);
  });

  it("signature 值改变不影响 payload", () => {
    const env1 = makeValidResultEnvelope();
    const env2 = { ...env1, signature: "different-sig" };
    expect(getResultSignPayload(env1)).toBe(getResultSignPayload(env2));
  });
});
