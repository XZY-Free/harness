/**
 * V10 Phase 6：BridgeClient.handleRpc 命令分发测试。
 *
 * 验证 handleRpc 根据 isActionCommand 正确分发：
 * - 读取类命令（browser.getTabs 等）→ executeReadCommand → commandTarget
 * - 操作类命令（browser.navigate 等）→ executeActionCommand → actionTarget
 *
 * 通过 mock commandTarget 和 actionTarget 的方法被调用来验证分发逻辑。
 * RPC 信封使用真实 ed25519 签名，确保通过 validateRpcEnvelope 完整校验。
 */
import { describe, expect, it } from "vitest";
import { PROTOCOL_VERSION } from "../../lib/desktop/protocol";
import { type RpcRequestEnvelope, getEnvelopeSignPayload } from "../../lib/desktop/rpc-envelope";
import {
  generateDeviceKeyPair,
  generateNonce,
  generateRequestId,
  signData,
} from "../../lib/desktop/signing";
import { AiLockManager } from "../browser/ai-lock";
import type { TabMetadata } from "../browser/tab-store";
import { BridgeClient } from "./bridge-client";
import type { BridgeClientConfig } from "./bridge-client";
import type { BrowserActionTarget, BrowserCommandTarget } from "./command-executor";
import type { DeviceIdentity } from "./device-identity";
import { createDeviceIdentity } from "./device-identity";

/**
 * 可测试的 BridgeClient —— 暴露私有成员用于测试。
 */
type TestableBridgeClient = BridgeClient & {
  handleRpc: (envelope: RpcRequestEnvelope) => Promise<void>;
  handleMessage: (message: unknown) => void;
  serverPublicKeyBase64: string | null;
  send: (message: unknown) => void;
};

/**
 * 内存 BrowserCommandTarget，记录调用并控制返回值。
 */
class MemoryCommandTarget implements BrowserCommandTarget {
  getTabsCalls: string[] = [];
  getActiveTabCalls: string[] = [];
  private tabs = new Map<string, TabMetadata[]>();

  setTabs(threadId: string, tabs: TabMetadata[]): void {
    this.tabs.set(threadId, tabs);
  }

  getTabs(threadId: string): TabMetadata[] {
    this.getTabsCalls.push(threadId);
    return this.tabs.get(threadId) ?? [];
  }

  getActiveTab(threadId: string): TabMetadata | null {
    this.getActiveTabCalls.push(threadId);
    return null;
  }
}

/**
 * 内存 BrowserActionTarget，记录调用并控制返回值。
 */
class MemoryActionTarget implements BrowserActionTarget {
  navigateCalls: Array<{ threadId: string; tabId: string; url: string }> = [];
  clickCalls: Array<{ threadId: string; tabId: string; x: number; y: number; button: string }> = [];
  typeCalls: Array<{ threadId: string; tabId: string; text: string; selector?: string }> = [];
  reloadCalls: Array<{ threadId: string; tabId: string }> = [];

  navigate(threadId: string, tabId: string, url: string): boolean {
    this.navigateCalls.push({ threadId, tabId, url });
    return true;
  }

  closeTab(): boolean {
    return true;
  }

  switchTab(): boolean {
    return true;
  }

  createTab(): TabMetadata | null {
    return null;
  }

  reload(threadId: string, tabId: string): boolean {
    this.reloadCalls.push({ threadId, tabId });
    return true;
  }

  goBack(): boolean {
    return true;
  }

  goForward(): boolean {
    return true;
  }

  async click(
    threadId: string,
    tabId: string,
    x: number,
    y: number,
    button = "left",
  ): Promise<boolean> {
    this.clickCalls.push({ threadId, tabId, x, y, button });
    return true;
  }

  async doubleClick(): Promise<boolean> {
    return true;
  }

  async type(threadId: string, tabId: string, text: string, selector?: string): Promise<boolean> {
    this.typeCalls.push({ threadId, tabId, text, selector });
    return true;
  }

  async press(): Promise<boolean> {
    return true;
  }

  async select(): Promise<boolean> {
    return true;
  }

  async scroll(): Promise<boolean> {
    return true;
  }

  async uploadWorkspaceFile(): Promise<boolean> {
    return true;
  }
}

/**
 * 创建签名后的 RPC 请求信封。
 *
 * 使用 server 私钥对信封规范序列化签名，确保通过 validateRpcEnvelope 校验。
 */
function createSignedEnvelope(
  fields: Omit<RpcRequestEnvelope, "signature">,
  serverPrivateKeyBase64: string,
): RpcRequestEnvelope {
  const signPayload = getEnvelopeSignPayload(fields);
  const signature = signData(signPayload, serverPrivateKeyBase64);
  return { ...fields, signature };
}

/**
 * 构造测试用 BridgeClient。
 *
 * 生成 server 密钥对和 device 身份，注入 mock targets。
 * 返回 TestableBridgeClient 以便直接调用 handleRpc。
 */
function createTestClient(
  commandTarget: BrowserCommandTarget,
  actionTarget: BrowserActionTarget,
  aiLockManager?: AiLockManager,
): { client: TestableBridgeClient; serverPublicKeyBase64: string } {
  // 生成 server 密钥对（用于签名 RPC 请求）
  const serverKeyPair = generateDeviceKeyPair();
  // 生成 device 身份
  const identity: DeviceIdentity = createDeviceIdentity();

  // 构造配置（包含 actionTarget）
  const config = {
    serverUrl: "ws://localhost:0",
    deviceIdentity: identity,
    deviceName: "test-device",
    deviceVersion: "0.0.0-test",
    commandTarget,
    actionTarget,
    aiLockManager,
  } as unknown as BridgeClientConfig;

  const client = new BridgeClient(config) as unknown as TestableBridgeClient;
  // 设置 server 公钥（模拟收到 challenge 后的状态）
  client.serverPublicKeyBase64 = serverKeyPair.publicKeyBase64;

  return { client, serverPublicKeyBase64: serverKeyPair.publicKeyBase64 };
}

describe("BridgeClient AI 锁消息", () => {
  it("lease_locked 获取本地锁，lease_released 释放同一 run", () => {
    const locks = new AiLockManager();
    const { client } = createTestClient(new MemoryCommandTarget(), new MemoryActionTarget(), locks);
    const deviceId = (client as unknown as { config: BridgeClientConfig }).config.deviceIdentity
      .deviceId;

    client.handleMessage({
      type: "lease_locked",
      threadId: "thread-1",
      deviceId,
      userId: "user-1",
      runId: "run-1",
      expiresAt: Date.now() + 60_000,
    });
    expect(locks.getLock("thread-1")?.runId).toBe("run-1");

    client.handleMessage({ type: "lease_released", threadId: "thread-1", runId: "run-1" });
    expect(locks.isLocked("thread-1")).toBe(false);
  });

  it("command_cancelled 释放对应本地锁", () => {
    const locks = new AiLockManager();
    const { client } = createTestClient(new MemoryCommandTarget(), new MemoryActionTarget(), locks);
    const deviceId = (client as unknown as { config: BridgeClientConfig }).config.deviceIdentity
      .deviceId;
    locks.acquire({
      threadId: "thread-1",
      userId: "user-1",
      deviceId,
      runId: "run-1",
      now: Date.now(),
    });

    client.handleMessage({
      type: "command_cancelled",
      threadId: "thread-1",
      runId: "run-1",
      reason: "user_takeover",
    });

    expect(locks.isLocked("thread-1")).toBe(false);
  });
});

/**
 * 生成基础信封字段（不含 signature）。
 */
function createBaseEnvelopeFields(
  overrides: Partial<Omit<RpcRequestEnvelope, "signature">> & {
    command: string;
    payload: unknown;
  },
  deviceId: string,
): Omit<RpcRequestEnvelope, "signature"> {
  const now = Date.now();
  return {
    protocolVersion: PROTOCOL_VERSION,
    requestId: generateRequestId(),
    deviceId,
    userId: "test-user",
    threadId: "thread-1",
    tabId: null,
    runId: null,
    approvalId: null,
    issuedAt: now,
    expiresAt: now + 60000,
    nonce: generateNonce(),
    ...overrides,
  };
}

describe("BridgeClient.handleRpc 命令分发", () => {
  describe("读取类命令分发到 executeReadCommand", () => {
    it("browser.getTabs 调用 commandTarget.getTabs", async () => {
      const commandTarget = new MemoryCommandTarget();
      const actionTarget = new MemoryActionTarget();
      const { client, serverPublicKeyBase64 } = createTestClient(commandTarget, actionTarget);

      // 从 client 获取 deviceId（构造时生成的）
      // 由于 deviceIdentity 是私有的，我们从 config 获取
      // 但 config 是 as unknown as BridgeClientConfig，所以需要另一种方式
      // 实际上 deviceId 在 envelope 中必须匹配，我们需要从 client 中获取
      // 使用 TestableBridgeClient 无法直接获取，所以重新构造
      const identity = (client as unknown as { config: { deviceIdentity: DeviceIdentity } }).config
        .deviceIdentity;

      const fields = createBaseEnvelopeFields(
        {
          command: "browser.getTabs",
          payload: { threadId: "thread-1" },
        },
        identity.deviceId,
      );

      // 生成 server 私钥用于签名
      // 重新生成与 serverPublicKeyBase64 匹配的私钥对
      // 由于 createTestClient 内部生成了密钥对但我们没拿到私钥，
      // 我们需要重构测试以获取私钥
      // 改用直接构造方式
      const serverKeyPair = generateDeviceKeyPair();
      client.serverPublicKeyBase64 = serverKeyPair.publicKeyBase64;

      const envelope = createSignedEnvelope(fields, serverKeyPair.privateKeyBase64);

      await client.handleRpc(envelope);

      expect(commandTarget.getTabsCalls).toContain("thread-1");
      expect(actionTarget.navigateCalls).toHaveLength(0);
    });

    it("browser.getPageMetadata 调用 commandTarget（不调用 actionTarget）", async () => {
      const commandTarget = new MemoryCommandTarget();
      commandTarget.setTabs("thread-1", [
        {
          id: "tab-1",
          threadId: "thread-1",
          url: "https://example.com",
          title: "示例",
          favicon: null,
          loadState: "loaded",
          canGoBack: false,
          canGoForward: false,
          incognito: false,
          createdAt: 1000,
          updatedAt: 2000,
          error: null,
        },
      ]);
      const actionTarget = new MemoryActionTarget();
      const { client } = createTestClient(commandTarget, actionTarget);

      const identity = (client as unknown as { config: { deviceIdentity: DeviceIdentity } }).config
        .deviceIdentity;
      const serverKeyPair = generateDeviceKeyPair();
      client.serverPublicKeyBase64 = serverKeyPair.publicKeyBase64;

      const fields = createBaseEnvelopeFields(
        {
          command: "browser.getPageMetadata",
          payload: { threadId: "thread-1", tabId: "tab-1" },
          tabId: "tab-1",
        },
        identity.deviceId,
      );
      const envelope = createSignedEnvelope(fields, serverKeyPair.privateKeyBase64);

      await client.handleRpc(envelope);

      expect(commandTarget.getTabsCalls).toContain("thread-1");
      expect(actionTarget.navigateCalls).toHaveLength(0);
    });
  });

  describe("操作类命令分发到 executeActionCommand", () => {
    it("browser.navigate 调用 actionTarget.navigate（不调用 commandTarget）", async () => {
      const commandTarget = new MemoryCommandTarget();
      const actionTarget = new MemoryActionTarget();
      const { client } = createTestClient(commandTarget, actionTarget);

      const identity = (client as unknown as { config: { deviceIdentity: DeviceIdentity } }).config
        .deviceIdentity;
      const serverKeyPair = generateDeviceKeyPair();
      client.serverPublicKeyBase64 = serverKeyPair.publicKeyBase64;

      const fields = createBaseEnvelopeFields(
        {
          command: "browser.navigate",
          payload: { threadId: "thread-1", tabId: "tab-1", url: "https://example.com" },
          tabId: "tab-1",
        },
        identity.deviceId,
      );
      const envelope = createSignedEnvelope(fields, serverKeyPair.privateKeyBase64);

      await client.handleRpc(envelope);

      expect(actionTarget.navigateCalls).toHaveLength(1);
      expect(actionTarget.navigateCalls[0]).toEqual({
        threadId: "thread-1",
        tabId: "tab-1",
        url: "https://example.com",
      });
      expect(commandTarget.getTabsCalls).toHaveLength(0);
    });

    it("browser.click 调用 actionTarget.click", async () => {
      const commandTarget = new MemoryCommandTarget();
      const actionTarget = new MemoryActionTarget();
      const { client } = createTestClient(commandTarget, actionTarget);

      const identity = (client as unknown as { config: { deviceIdentity: DeviceIdentity } }).config
        .deviceIdentity;
      const serverKeyPair = generateDeviceKeyPair();
      client.serverPublicKeyBase64 = serverKeyPair.publicKeyBase64;

      const fields = createBaseEnvelopeFields(
        {
          command: "browser.click",
          payload: { threadId: "thread-1", tabId: "tab-1", x: 100, y: 200, button: "right" },
          tabId: "tab-1",
        },
        identity.deviceId,
      );
      const envelope = createSignedEnvelope(fields, serverKeyPair.privateKeyBase64);

      await client.handleRpc(envelope);

      expect(actionTarget.clickCalls).toHaveLength(1);
      expect(actionTarget.clickCalls[0]).toEqual({
        threadId: "thread-1",
        tabId: "tab-1",
        x: 100,
        y: 200,
        button: "right",
      });
    });

    it("browser.type 调用 actionTarget.type", async () => {
      const commandTarget = new MemoryCommandTarget();
      const actionTarget = new MemoryActionTarget();
      const { client } = createTestClient(commandTarget, actionTarget);

      const identity = (client as unknown as { config: { deviceIdentity: DeviceIdentity } }).config
        .deviceIdentity;
      const serverKeyPair = generateDeviceKeyPair();
      client.serverPublicKeyBase64 = serverKeyPair.publicKeyBase64;

      const fields = createBaseEnvelopeFields(
        {
          command: "browser.type",
          payload: { threadId: "thread-1", tabId: "tab-1", text: "hello", selector: "#input" },
          tabId: "tab-1",
        },
        identity.deviceId,
      );
      const envelope = createSignedEnvelope(fields, serverKeyPair.privateKeyBase64);

      await client.handleRpc(envelope);

      expect(actionTarget.typeCalls).toHaveLength(1);
      expect(actionTarget.typeCalls[0]).toEqual({
        threadId: "thread-1",
        tabId: "tab-1",
        text: "hello",
        selector: "#input",
      });
    });

    it("browser.reload 调用 actionTarget.reload", async () => {
      const commandTarget = new MemoryCommandTarget();
      const actionTarget = new MemoryActionTarget();
      const { client } = createTestClient(commandTarget, actionTarget);

      const identity = (client as unknown as { config: { deviceIdentity: DeviceIdentity } }).config
        .deviceIdentity;
      const serverKeyPair = generateDeviceKeyPair();
      client.serverPublicKeyBase64 = serverKeyPair.publicKeyBase64;

      const fields = createBaseEnvelopeFields(
        {
          command: "browser.reload",
          payload: { threadId: "thread-1", tabId: "tab-1" },
          tabId: "tab-1",
        },
        identity.deviceId,
      );
      const envelope = createSignedEnvelope(fields, serverKeyPair.privateKeyBase64);

      await client.handleRpc(envelope);

      expect(actionTarget.reloadCalls).toHaveLength(1);
      expect(actionTarget.reloadCalls[0]).toEqual({
        threadId: "thread-1",
        tabId: "tab-1",
      });
    });
  });

  describe("信封校验失败时不分发", () => {
    it("deviceId 不匹配时不调用任何 target", async () => {
      const commandTarget = new MemoryCommandTarget();
      const actionTarget = new MemoryActionTarget();
      const { client } = createTestClient(commandTarget, actionTarget);

      const serverKeyPair = generateDeviceKeyPair();
      client.serverPublicKeyBase64 = serverKeyPair.publicKeyBase64;

      // 使用不同的 deviceId（不匹配）
      const fields = createBaseEnvelopeFields(
        {
          command: "browser.navigate",
          payload: { threadId: "thread-1", tabId: "tab-1", url: "https://example.com" },
          tabId: "tab-1",
          deviceId: "wrong-device-id",
        },
        "wrong-device-id",
      );
      const envelope = createSignedEnvelope(fields, serverKeyPair.privateKeyBase64);

      await client.handleRpc(envelope);

      expect(actionTarget.navigateCalls).toHaveLength(0);
      expect(commandTarget.getTabsCalls).toHaveLength(0);
    });

    it("签名无效时不调用任何 target", async () => {
      const commandTarget = new MemoryCommandTarget();
      const actionTarget = new MemoryActionTarget();
      const { client } = createTestClient(commandTarget, actionTarget);

      const identity = (client as unknown as { config: { deviceIdentity: DeviceIdentity } }).config
        .deviceIdentity;

      // 用不同的密钥对签名（签名不匹配）
      const otherKeyPair = generateDeviceKeyPair();
      client.serverPublicKeyBase64 = otherKeyPair.publicKeyBase64;

      const fields = createBaseEnvelopeFields(
        {
          command: "browser.navigate",
          payload: { threadId: "thread-1", tabId: "tab-1", url: "https://example.com" },
          tabId: "tab-1",
        },
        identity.deviceId,
      );
      // 用第三个密钥对签名（与 serverPublicKeyBase64 不匹配）
      const signingKeyPair = generateDeviceKeyPair();
      const envelope = createSignedEnvelope(fields, signingKeyPair.privateKeyBase64);

      await client.handleRpc(envelope);

      expect(actionTarget.navigateCalls).toHaveLength(0);
      expect(commandTarget.getTabsCalls).toHaveLength(0);
    });
  });
});
