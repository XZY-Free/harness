/**
 * V10 Phase 5：Agent Bridge WebSocket 消息协议测试。
 */
import { describe, expect, it } from "vitest";
import {
  authFailedMessageSchema,
  authMessageSchema,
  authOkMessageSchema,
  cancelCommandMessageSchema,
  challengeMessageSchema,
  commandCancelledMessageSchema,
  heartbeatAckMessageSchema,
  heartbeatMessageSchema,
  leaseLockedMessageSchema,
  leaseReleaseMessageSchema,
  leaseReleasedMessageSchema,
  leaseRequestMessageSchema,
  leaseRevokedMessageSchema,
  parseClientMessage,
  parseServerMessage,
  rpcRequestMessageSchema,
  rpcResultMessageSchema,
  serializeMessage,
  serverErrorMessageSchema,
} from "./bridge-messages";
import { PROTOCOL_VERSION } from "./protocol";

describe("bridge-messages", () => {
  describe("Server → Desktop 消息", () => {
    it("challenge 消息校验", () => {
      const msg = {
        type: "challenge",
        challenge: "abc123",
        serverPublicKey: "pubkey-base64",
        protocolVersion: PROTOCOL_VERSION,
      };
      expect(challengeMessageSchema.parse(msg)).toEqual(msg);
    });

    it("auth_ok 消息校验", () => {
      const msg = {
        type: "auth_ok",
        protocolVersion: PROTOCOL_VERSION,
        deviceRecordId: "record-1",
        serverTime: Date.now(),
      };
      expect(authOkMessageSchema.parse(msg)).toEqual(msg);
    });

    it("auth_failed 消息校验", () => {
      const msg = {
        type: "auth_failed",
        error: { code: "desktop_unauthorized", message: "设备未注册" },
      };
      const result = authFailedMessageSchema.safeParse(msg);
      expect(result.success).toBe(true);
    });

    it("rpc 消息校验", () => {
      const msg = {
        type: "rpc",
        envelope: { requestId: "req-1", command: "browser.getTabs" },
      };
      expect(rpcRequestMessageSchema.parse(msg)).toEqual(msg);
    });

    it("heartbeat 消息校验", () => {
      const msg = { type: "heartbeat", timestamp: Date.now() };
      expect(heartbeatMessageSchema.parse(msg)).toEqual(msg);
    });

    it("lease_revoked 消息校验", () => {
      const msg = { type: "lease_revoked", threadId: "thread-1", reason: "设备接管" };
      expect(leaseRevokedMessageSchema.parse(msg)).toEqual(msg);
    });

    it("lease_locked 消息校验", () => {
      const msg = {
        type: "lease_locked",
        threadId: "thread-1",
        deviceId: "device-1",
        userId: "user-1",
        runId: "run-1",
        expiresAt: Date.now() + 30000,
      };
      expect(leaseLockedMessageSchema.parse(msg)).toEqual(msg);
    });

    it("lease_locked 消息缺少 runId 时拒绝", () => {
      const msg = {
        type: "lease_locked",
        threadId: "thread-1",
        deviceId: "device-1",
        userId: "user-1",
        expiresAt: Date.now() + 30000,
      };
      expect(() => leaseLockedMessageSchema.parse(msg)).toThrow();
    });

    it("lease_released 消息校验", () => {
      const msg = {
        type: "lease_released",
        threadId: "thread-1",
        runId: "run-1",
      };
      expect(leaseReleasedMessageSchema.parse(msg)).toEqual(msg);
    });

    it("lease_released 消息缺少 runId 时拒绝", () => {
      const msg = { type: "lease_released", threadId: "thread-1" };
      expect(() => leaseReleasedMessageSchema.parse(msg)).toThrow();
    });

    it("command_cancelled 消息校验", () => {
      const msg = {
        type: "command_cancelled",
        threadId: "thread-1",
        runId: "run-1",
        reason: "user_takeover",
      };
      expect(commandCancelledMessageSchema.parse(msg)).toEqual(msg);
    });

    it("command_cancelled 消息缺少 reason 时拒绝", () => {
      const msg = { type: "command_cancelled", threadId: "thread-1", runId: "run-1" };
      expect(() => commandCancelledMessageSchema.parse(msg)).toThrow();
    });

    it("error 消息校验", () => {
      const msg = {
        type: "error",
        error: { code: "protocol_mismatch", message: "协议版本不兼容" },
      };
      expect(serverErrorMessageSchema.parse(msg)).toEqual(msg);
    });
  });

  describe("Desktop → Server 消息", () => {
    it("auth 消息校验", () => {
      const msg = {
        type: "auth",
        deviceId: "device-1",
        signature: "sig-base64",
        version: "1.0.0",
        name: "MacBook Pro",
        protocolVersion: PROTOCOL_VERSION,
      };
      expect(authMessageSchema.parse(msg)).toEqual(msg);
    });

    it("rpc_result 消息校验", () => {
      const msg = {
        type: "rpc_result",
        envelope: { requestId: "req-1", ok: true, result: { tabs: [] } },
      };
      expect(rpcResultMessageSchema.parse(msg)).toEqual(msg);
    });

    it("heartbeat_ack 消息校验", () => {
      const msg = { type: "heartbeat_ack", timestamp: Date.now() };
      expect(heartbeatAckMessageSchema.parse(msg)).toEqual(msg);
    });

    it("lease_request 消息校验", () => {
      const msg = { type: "lease_request", threadId: "thread-1" };
      expect(leaseRequestMessageSchema.parse(msg)).toEqual(msg);
    });

    it("lease_release 消息校验", () => {
      const msg = { type: "lease_release", threadId: "thread-1" };
      expect(leaseReleaseMessageSchema.parse(msg)).toEqual(msg);
    });

    it("cancel_command 消息校验", () => {
      const msg = {
        type: "cancel_command",
        threadId: "thread-1",
        runId: "run-1",
        reason: "user_takeover",
      };
      expect(cancelCommandMessageSchema.parse(msg)).toEqual(msg);
    });

    it("cancel_command 消息缺少 runId 时拒绝", () => {
      const msg = { type: "cancel_command", threadId: "thread-1", reason: "user_takeover" };
      expect(() => cancelCommandMessageSchema.parse(msg)).toThrow();
    });
  });

  describe("消息联合校验", () => {
    it("parseServerMessage 解析有效 challenge", () => {
      const raw = {
        type: "challenge",
        challenge: "abc",
        serverPublicKey: "pk",
        protocolVersion: PROTOCOL_VERSION,
      };
      const result = parseServerMessage(raw);
      expect(result.ok).toBe(true);
    });

    it("parseServerMessage 解析有效 lease_locked", () => {
      const raw = {
        type: "lease_locked",
        threadId: "thread-1",
        deviceId: "device-1",
        userId: "user-1",
        runId: "run-1",
        expiresAt: Date.now() + 30000,
      };
      const result = parseServerMessage(raw);
      expect(result.ok).toBe(true);
    });

    it("parseServerMessage 解析有效 lease_released", () => {
      const raw = {
        type: "lease_released",
        threadId: "thread-1",
        runId: "run-1",
      };
      const result = parseServerMessage(raw);
      expect(result.ok).toBe(true);
    });

    it("parseServerMessage 解析有效 command_cancelled", () => {
      const raw = {
        type: "command_cancelled",
        threadId: "thread-1",
        runId: "run-1",
        reason: "user_takeover",
      };
      const result = parseServerMessage(raw);
      expect(result.ok).toBe(true);
    });

    it("parseServerMessage 拒绝无效消息", () => {
      const result = parseServerMessage({ type: "unknown" });
      expect(result.ok).toBe(false);
    });

    it("parseClientMessage 解析有效 auth", () => {
      const raw = {
        type: "auth",
        deviceId: "dev",
        signature: "sig",
        version: "1.0",
        name: "Mac",
        protocolVersion: PROTOCOL_VERSION,
      };
      const result = parseClientMessage(raw);
      expect(result.ok).toBe(true);
    });

    it("parseClientMessage 解析有效 cancel_command", () => {
      const raw = {
        type: "cancel_command",
        threadId: "thread-1",
        runId: "run-1",
        reason: "user_takeover",
      };
      const result = parseClientMessage(raw);
      expect(result.ok).toBe(true);
    });

    it("parseClientMessage 拒绝无效消息", () => {
      const result = parseClientMessage({ type: "challenge" });
      expect(result.ok).toBe(false);
    });

    it("serializeMessage 正确序列化", () => {
      const msg = { type: "heartbeat", timestamp: 1000 } as const;
      const json = serializeMessage(msg);
      expect(JSON.parse(json)).toEqual(msg);
    });
  });

  describe("协议版本校验", () => {
    it("challenge 协议版本不匹配时拒绝", () => {
      const msg = {
        type: "challenge",
        challenge: "abc",
        serverPublicKey: "pk",
        protocolVersion: 999,
      };
      expect(() => challengeMessageSchema.parse(msg)).toThrow();
    });

    it("auth 协议版本不匹配时拒绝", () => {
      const msg = {
        type: "auth",
        deviceId: "dev",
        signature: "sig",
        version: "1.0",
        name: "Mac",
        protocolVersion: 999,
      };
      expect(() => authMessageSchema.parse(msg)).toThrow();
    });
  });
});
