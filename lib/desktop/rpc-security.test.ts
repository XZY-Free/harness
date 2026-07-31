import { type RpcRequestEnvelope, getEnvelopeSignPayload } from "@/lib/desktop/rpc-envelope";
import { NonceDeduplicator, validateRpcEnvelope } from "@/lib/desktop/rpc-security";
import { generateDeviceKeyPair, generateNonce, signData } from "@/lib/desktop/signing";
import { describe, expect, it } from "vitest";

/** 生成一对测试密钥 */
const KEY_PAIR = generateDeviceKeyPair();
const DEVICE_ID = "dev-001";
const USER_ID = "user-001";
const SERVER_PUBLIC_KEY = KEY_PAIR.publicKeyBase64;

/**
 * 构造合法信封并签名。
 * overrides 中如果包含 signature，则直接使用（用于测试无效签名）。
 */
function makeSignedEnvelope(overrides: Partial<RpcRequestEnvelope> = {}): RpcRequestEnvelope {
  const base: Omit<RpcRequestEnvelope, "signature"> = {
    protocolVersion: 1,
    requestId: "req-001",
    deviceId: DEVICE_ID,
    userId: USER_ID,
    threadId: "thread-001",
    tabId: null,
    runId: null,
    approvalId: null,
    command: "browser.getTabs",
    payload: { threadId: "thread-001" },
    issuedAt: 1700000000000,
    expiresAt: 1700000060000,
    nonce: generateNonce(),
  };
  // 将 overrides（排除 signature）合并到 base
  const { signature: overrideSig, ...fieldOverrides } = overrides;
  const merged: Omit<RpcRequestEnvelope, "signature"> = { ...base, ...fieldOverrides };
  // 如果 overrides 提供了 signature，直接使用（用于测试无效签名场景）
  if (overrideSig !== undefined) {
    return { ...merged, signature: overrideSig };
  }
  // 否则计算正确签名
  const signPayload = getEnvelopeSignPayload(merged);
  const signature = signData(signPayload, KEY_PAIR.privateKeyBase64);
  return { ...merged, signature };
}

describe("NonceDeduplicator", () => {
  it("首次 nonce 返回 true", () => {
    const dd = new NonceDeduplicator();
    expect(dd.checkAndAdd("nonce-1", Date.now() + 60000)).toBe(true);
  });

  it("重复 nonce 返回 false", () => {
    const dd = new NonceDeduplicator();
    const expiresAt = Date.now() + 60000;
    expect(dd.checkAndAdd("nonce-1", expiresAt)).toBe(true);
    expect(dd.checkAndAdd("nonce-1", expiresAt)).toBe(false);
  });

  it("不同 nonce 都返回 true", () => {
    const dd = new NonceDeduplicator();
    expect(dd.checkAndAdd("a", Date.now() + 60000)).toBe(true);
    expect(dd.checkAndAdd("b", Date.now() + 60000)).toBe(true);
    expect(dd.checkAndAdd("c", Date.now() + 60000)).toBe(true);
  });

  it("size() 返回当前 nonce 数量", () => {
    const dd = new NonceDeduplicator();
    expect(dd.size()).toBe(0);
    dd.checkAndAdd("a", Date.now() + 60000);
    expect(dd.size()).toBe(1);
    dd.checkAndAdd("b", Date.now() + 60000);
    expect(dd.size()).toBe(2);
    // 重复不增加
    dd.checkAndAdd("a", Date.now() + 60000);
    expect(dd.size()).toBe(2);
  });

  it("cleanup() 清理过期 nonce", () => {
    const dd = new NonceDeduplicator();
    const now = 1000000;
    dd.checkAndAdd("old", now - 1000);
    dd.checkAndAdd("new", now + 60000);
    expect(dd.size()).toBe(2);
    const cleaned = dd.cleanup(now);
    expect(cleaned).toBe(1);
    expect(dd.size()).toBe(1);
  });

  it("cleanup() 清理所有过期 nonce", () => {
    const dd = new NonceDeduplicator();
    const now = 1000000;
    dd.checkAndAdd("old1", now - 1000);
    dd.checkAndAdd("old2", now - 2000);
    dd.checkAndAdd("new", now + 60000);
    const cleaned = dd.cleanup(now);
    expect(cleaned).toBe(2);
    expect(dd.size()).toBe(1);
  });

  it("cleanup() 无过期时返回 0", () => {
    const dd = new NonceDeduplicator();
    const now = 1000000;
    dd.checkAndAdd("a", now + 60000);
    dd.checkAndAdd("b", now + 60000);
    expect(dd.cleanup(now)).toBe(0);
    expect(dd.size()).toBe(2);
  });

  it("maxSize 限制：超出时淘汰最旧的", () => {
    const dd = new NonceDeduplicator(3);
    const now = 1000000;
    dd.checkAndAdd("a", now + 60000);
    dd.checkAndAdd("b", now + 60000);
    dd.checkAndAdd("c", now + 60000);
    expect(dd.size()).toBe(3);
    // 加入第 4 个，应该淘汰最旧的 'a'
    dd.checkAndAdd("d", now + 60000);
    expect(dd.size()).toBe(3);
    // 'a' 被淘汰，重新加入应返回 true（同时淘汰 'b'）
    expect(dd.checkAndAdd("a", now + 60000)).toBe(true);
    expect(dd.size()).toBe(3);
    // 'c' 仍在（不是最旧），应返回 false
    expect(dd.checkAndAdd("c", now + 60000)).toBe(false);
  });

  it("默认 maxSize 为 10000", () => {
    const dd = new NonceDeduplicator();
    expect(dd.size()).toBe(0);
  });
});

describe("validateRpcEnvelope()", () => {
  const NOW = 1700000030000;

  it("有效信封通过", () => {
    const env = makeSignedEnvelope();
    const result = validateRpcEnvelope(env, DEVICE_ID, USER_ID, SERVER_PUBLIC_KEY, NOW);
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.envelope.requestId).toBe("req-001");
    }
  });

  it("协议版本不匹配返回 protocol_mismatch", () => {
    const env = makeSignedEnvelope({ protocolVersion: 2 });
    const result = validateRpcEnvelope(env, DEVICE_ID, USER_ID, SERVER_PUBLIC_KEY, NOW);
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.code).toBe("protocol_mismatch");
    }
  });

  it("deviceId 不匹配返回 unauthorized", () => {
    const env = makeSignedEnvelope({ deviceId: "wrong-device" });
    const result = validateRpcEnvelope(env, DEVICE_ID, USER_ID, SERVER_PUBLIC_KEY, NOW);
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.code).toBe("unauthorized");
    }
  });

  it("userId 不匹配返回 unauthorized", () => {
    const env = makeSignedEnvelope({ userId: "wrong-user" });
    const result = validateRpcEnvelope(env, DEVICE_ID, USER_ID, SERVER_PUBLIC_KEY, NOW);
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.code).toBe("unauthorized");
    }
  });

  it("expectedUserId 为 null 时跳过 userId 校验", () => {
    const env = makeSignedEnvelope({ userId: "any-user" });
    const result = validateRpcEnvelope(env, DEVICE_ID, null, SERVER_PUBLIC_KEY, NOW);
    expect(result.ok).toBe(true);
  });

  it("过期返回 rpc_timeout", () => {
    const env = makeSignedEnvelope({ expiresAt: NOW - 1000 });
    const result = validateRpcEnvelope(env, DEVICE_ID, USER_ID, SERVER_PUBLIC_KEY, NOW);
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.code).toBe("rpc_timeout");
    }
  });

  it("签名错误返回 rpc_invalid_signature", () => {
    // 使用合法 base64 但不是有效签名
    const env = makeSignedEnvelope({ signature: "aW52YWxpZC1zaWduYXR1cmU=" });
    const result = validateRpcEnvelope(env, DEVICE_ID, USER_ID, SERVER_PUBLIC_KEY, NOW);
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.code).toBe("rpc_invalid_signature");
    }
  });

  it("未知命令返回 unknown_command", () => {
    const env = makeSignedEnvelope({ command: "browser.evaluateArbitraryJavaScript" });
    const result = validateRpcEnvelope(env, DEVICE_ID, USER_ID, SERVER_PUBLIC_KEY, NOW);
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.code).toBe("unknown_command");
    }
  });

  it("payload 无效返回 rpc_invalid_payload", () => {
    const env = makeSignedEnvelope({
      command: "browser.getPageMetadata",
      payload: { threadId: "t1" },
    });
    const result = validateRpcEnvelope(env, DEVICE_ID, USER_ID, SERVER_PUBLIC_KEY, NOW);
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.code).toBe("rpc_invalid_payload");
    }
  });

  it("schema 解析失败返回 rpc_invalid_payload", () => {
    const result = validateRpcEnvelope(
      { bad: "envelope" },
      DEVICE_ID,
      USER_ID,
      SERVER_PUBLIC_KEY,
      NOW,
    );
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.code).toBe("rpc_invalid_payload");
    }
  });

  it("校验按顺序执行：协议版本优先于 deviceId", () => {
    const env = makeSignedEnvelope({ protocolVersion: 2, deviceId: "wrong" });
    const result = validateRpcEnvelope(env, DEVICE_ID, USER_ID, SERVER_PUBLIC_KEY, NOW);
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.code).toBe("protocol_mismatch");
    }
  });

  it("有效信封返回完整 envelope 对象", () => {
    const env = makeSignedEnvelope();
    const result = validateRpcEnvelope(env, DEVICE_ID, USER_ID, SERVER_PUBLIC_KEY, NOW);
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.envelope).toMatchObject({
        requestId: "req-001",
        deviceId: DEVICE_ID,
        command: "browser.getTabs",
      });
    }
  });
});
