/**
 * V10 Phase 5：rpc-dispatcher 测试。
 */
import {
  type DispatchParams,
  createSignedEnvelope,
  prepareDispatch,
} from "@/lib/desktop-bridge/rpc-dispatcher";
import { getEnvelopeSignPayload } from "@/lib/desktop/rpc-envelope";
import { generateDeviceKeyPair, verifySignature } from "@/lib/desktop/signing";
import { describe, expect, it } from "vitest";

const NOW = 1700000000000;

function makeServerKey(): { publicKeyBase64: string; privateKeyBase64: string } {
  return generateDeviceKeyPair();
}

function makeParams(overrides: Partial<DispatchParams> = {}): DispatchParams {
  return {
    deviceId: "dev-001",
    userId: "user-001",
    threadId: "thread-001",
    command: "browser.getTabs",
    payload: { threadId: "thread-001" },
    serverPrivateKeyBase64: makeServerKey().privateKeyBase64,
    ...overrides,
  };
}

describe("createSignedEnvelope()", () => {
  it("返回包含所有必填字段的信封", () => {
    const serverKey = makeServerKey();
    const params: DispatchParams = {
      deviceId: "dev-001",
      userId: "user-001",
      threadId: "thread-001",
      command: "browser.getTabs",
      payload: { threadId: "thread-001" },
      serverPrivateKeyBase64: serverKey.privateKeyBase64,
    };
    const env = createSignedEnvelope(params, NOW);
    expect(env.protocolVersion).toBe(1);
    expect(env.deviceId).toBe("dev-001");
    expect(env.userId).toBe("user-001");
    expect(env.threadId).toBe("thread-001");
    expect(env.command).toBe("browser.getTabs");
    expect(env.payload).toEqual({ threadId: "thread-001" });
    expect(env.issuedAt).toBe(NOW);
    expect(env.expiresAt).toBe(NOW + 30000);
    expect(env.requestId).toBeTruthy();
    expect(env.nonce).toBeTruthy();
    expect(env.signature).toBeTruthy();
    // tabId / runId / approvalId 默认 null
    expect(env.tabId).toBeNull();
    expect(env.runId).toBeNull();
    expect(env.approvalId).toBeNull();
  });

  it("签名验证通过（使用 verifySignature 验证）", () => {
    const serverKey = makeServerKey();
    const params = makeParams({ serverPrivateKeyBase64: serverKey.privateKeyBase64 });
    const env = createSignedEnvelope(params, NOW);
    const signPayload = getEnvelopeSignPayload(env);
    expect(verifySignature(signPayload, env.signature, serverKey.publicKeyBase64)).toBe(true);
  });

  it("expiresAt = issuedAt + ttlMs（默认 30000）", () => {
    const params = makeParams();
    const env = createSignedEnvelope(params, NOW);
    expect(env.expiresAt).toBe(NOW + 30000);
  });

  it("自定义 ttlMs 生效", () => {
    const params = makeParams({ ttlMs: 60000 });
    const env = createSignedEnvelope(params, NOW);
    expect(env.expiresAt).toBe(NOW + 60000);
  });

  it("tabId / runId / approvalId 可选传入", () => {
    const params = makeParams({
      tabId: "tab-001",
      runId: "run-001",
      approvalId: "approval-001",
    });
    const env = createSignedEnvelope(params, NOW);
    expect(env.tabId).toBe("tab-001");
    expect(env.runId).toBe("run-001");
    expect(env.approvalId).toBe("approval-001");
  });

  it("每次调用生成不同的 requestId 和 nonce", () => {
    const params = makeParams();
    const env1 = createSignedEnvelope(params, NOW);
    const env2 = createSignedEnvelope(params, NOW);
    expect(env1.requestId).not.toBe(env2.requestId);
    expect(env1.nonce).not.toBe(env2.nonce);
    expect(env1.signature).not.toBe(env2.signature);
  });
});

describe("prepareDispatch()", () => {
  it("正常参数返回 ok=true 和 envelope", () => {
    const params = makeParams();
    const result = prepareDispatch(params, NOW);
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.envelope).toBeDefined();
      expect(result.envelope.command).toBe("browser.getTabs");
    }
  });

  it("未知命令返回 unknown_command", () => {
    const params = makeParams({ command: "browser.unknownCmd", payload: {} });
    const result = prepareDispatch(params, NOW);
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.code).toBe("unknown_command");
    }
  });

  it("无效 payload 返回 rpc_invalid_payload", () => {
    // browser.getTabs 需要 { threadId: string }，传入 {} 应失败
    const params = makeParams({ command: "browser.getTabs", payload: {} });
    const result = prepareDispatch(params, NOW);
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.code).toBe("rpc_invalid_payload");
    }
  });

  it("browser.getPageMetadata 缺少 tabId 返回 rpc_invalid_payload", () => {
    const params = makeParams({
      command: "browser.getPageMetadata",
      payload: { threadId: "thread-001" },
    });
    const result = prepareDispatch(params, NOW);
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.code).toBe("rpc_invalid_payload");
    }
  });

  it("browser.screenshot format 非法返回 rpc_invalid_payload", () => {
    const params = makeParams({
      command: "browser.screenshot",
      payload: { threadId: "thread-001", tabId: "tab-001", format: "gif" },
    });
    const result = prepareDispatch(params, NOW);
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.code).toBe("rpc_invalid_payload");
    }
  });

  it("browser.screenshot 合法 payload 返回 ok=true", () => {
    const params = makeParams({
      command: "browser.screenshot",
      payload: { threadId: "thread-001", tabId: "tab-001", format: "png" },
    });
    const result = prepareDispatch(params, NOW);
    expect(result.ok).toBe(true);
  });

  it("返回的信封签名验证通过", () => {
    const serverKey = makeServerKey();
    const params = makeParams({ serverPrivateKeyBase64: serverKey.privateKeyBase64 });
    const result = prepareDispatch(params, NOW);
    expect(result.ok).toBe(true);
    if (result.ok) {
      const env = result.envelope;
      const signPayload = getEnvelopeSignPayload(env);
      expect(verifySignature(signPayload, env.signature, serverKey.publicKeyBase64)).toBe(true);
    }
  });
});
