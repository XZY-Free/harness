/**
 * registerIpcHandlers 测试。
 *
 * 用受控的 FakeBridgeClient 替换真实 BridgeClient，验证：
 * - device:register 注册闭环：同源 fetch、请求体构造、校验、回填 Keychain、立即连接
 * - 幂等：已注册时复用租户并 ensureConnected，不重复 fetch
 * - 校验失败（deviceId 不符 / tenantId 非法）返回错误且不回填
 * - Bridge getState/connect/disconnect/onStateChange 无条件注册并动态读取 lifecycle
 * - cancelAi 动态读取 lifecycle 当前 client
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { DesktopCapabilities } from "../../lib/desktop/capabilities";
import { DESKTOP_CAPABILITY_VERSION, DESKTOP_IPC_CHANNELS } from "../../lib/desktop/capabilities";
import type { ConnectionState } from "../../lib/desktop/connection-state";
import { DesktopBridgeLifecycle } from "../bridge/bridge-lifecycle";
import type { BrowserActionTarget, BrowserCommandTarget } from "../bridge/command-executor";
import { DEVICE_IDENTITY_KEY, type DeviceIdentity } from "../bridge/device-identity";

interface FakeBridgeClient {
  connect: ReturnType<typeof vi.fn>;
  disconnect: ReturnType<typeof vi.fn>;
  getState: ReturnType<typeof vi.fn>;
  onStateChange: ReturnType<typeof vi.fn>;
  cancelAndTakeOver: ReturnType<typeof vi.fn>;
}

const instances: FakeBridgeClient[] = [];

const mockBridgeClient = vi.hoisted(() => ({
  BridgeClient: class {
    private state: ConnectionState = "disconnected";
    private listeners = new Set<(state: ConnectionState) => void>();
    connect = vi.fn(() => {});
    disconnect = vi.fn(() => {});
    getState = vi.fn(() => this.state);
    cancelAndTakeOver = vi.fn(() => true);
    constructor(config: unknown) {
      const self = this as unknown as FakeBridgeClient;
      self.onStateChange = vi.fn((listener: (state: ConnectionState) => void) => {
        this.listeners.add(listener);
        return () => {
          this.listeners.delete(listener);
        };
      });
      instances.push(self);
      void config;
    }
    transition(to: ConnectionState): void {
      this.state = to;
      for (const l of this.listeners) l(to);
    }
  },
}));

vi.mock("../bridge/bridge-client", () => mockBridgeClient);

import { registerIpcHandlers } from "./ipc-handlers";

const TID = "a0eebc99-9c0b-4ef8-bb6d-6bb9bd380a11";

const capabilities: DesktopCapabilities = {
  version: DESKTOP_CAPABILITY_VERSION,
  serverOrigin: "http://localhost:3000",
  appVersion: "1.0.0",
  ipcChannels: DESKTOP_IPC_CHANNELS,
  deviceId: "11111111-1111-4111-8111-111111111111",
};

function makeIdentity(tenantId: string | null): DeviceIdentity {
  return {
    deviceId: "11111111-1111-4111-8111-111111111111",
    keyPair: { publicKeyBase64: "pk", privateKeyBase64: "sk" },
    tenantId,
  };
}

const commandTarget = {} as unknown as BrowserCommandTarget;
const actionTarget = {} as unknown as BrowserActionTarget;

interface FakeIpcMain {
  handlers: Map<string, (...args: never[]) => unknown>;
  handle: (channel: string, handler: (...args: never[]) => unknown) => void;
  invoke: (channel: string, ...args: never[]) => Promise<unknown>;
}

function makeIpcMain(): FakeIpcMain {
  const handlers = new Map<string, (...args: never[]) => unknown>();
  return {
    handlers,
    handle: (channel, handler) => {
      handlers.set(channel, handler);
    },
    invoke: (channel, ...args) => {
      const h = handlers.get(channel);
      if (!h) throw new Error(`no handler for channel: ${channel}`);
      return Promise.resolve(h(...args));
    },
  };
}

function makeKeychain() {
  return {
    get: vi.fn().mockResolvedValue(null),
    set: vi.fn().mockResolvedValue(undefined),
    delete: vi.fn().mockResolvedValue(undefined),
  };
}

function makeEvent(fetchImpl: ReturnType<typeof vi.fn>) {
  return { sender: { session: { fetch: fetchImpl } } };
}

function makeRegistrationPayload(overrides: Partial<{ deviceId: string; name: string }> = {}) {
  return {
    deviceId: overrides.deviceId ?? "11111111-1111-4111-8111-111111111111",
    publicKey: "pk",
    name: overrides.name ?? "test-host",
    version: "1.0.0",
    tenantId: null,
  };
}

describe("registerIpcHandlers (device:register 闭环)", () => {
  beforeEach(() => {
    instances.length = 0;
  });

  afterEach(() => {
    vi.clearAllMocks();
  });

  it("成功注册：同源 fetch、请求体不含 tenantId、校验通过后回填 Keychain 并连接", async () => {
    const identity = makeIdentity(null);
    const lifecycle = new DesktopBridgeLifecycle(identity, {
      serverUrl: "ws://localhost:3002",
      deviceName: "test-host",
      deviceVersion: "1.0.0",
      commandTarget,
      actionTarget,
    });
    const fetchImpl = vi
      .fn()
      .mockResolvedValue(
        new Response(
          JSON.stringify({ ok: true, data: { deviceId: identity.deviceId, tenantId: TID } }),
        ),
      );
    const keychain = makeKeychain();
    const ipc = makeIpcMain();
    registerIpcHandlers(ipc, capabilities, makeRegistrationPayload(), lifecycle, keychain);

    const result = await ipc.invoke("desktop:device:register", makeEvent(fetchImpl));

    expect(result).toEqual({ ok: true, tenantId: TID });
    // fetch 打到同源注册端点
    expect(fetchImpl).toHaveBeenCalledTimes(1);
    const [url, init] = fetchImpl.mock.calls[0] as [string, { body: string }];
    expect(url).toBe("http://localhost:3000/api/desktop/devices/register");
    // 请求体由 main 的 payload 构造，且不含 tenantId（不信任 renderer 传租户）
    const body = JSON.parse(init.body) as Record<string, string>;
    expect(body).toEqual({
      deviceId: identity.deviceId,
      publicKey: "pk",
      name: "test-host",
      version: "1.0.0",
    });
    expect("tenantId" in body).toBe(false);
    // Keychain 已回填（saveDeviceIdentity 会调用 set）
    expect(keychain.set).toHaveBeenCalled();
    // 立即创建并连接 Bridge（无需重启）
    expect(lifecycle.isRegistered()).toBe(true);
    expect(lifecycle.getIdentity().tenantId).toBe(TID);
    expect(instances.length).toBe(1);
    expect(instances[0].connect).toHaveBeenCalledTimes(1);
  });

  it("幂等：已注册时复用租户并 ensureConnected，不重复 fetch", async () => {
    const identity = makeIdentity(null);
    const lifecycle = new DesktopBridgeLifecycle(identity, {
      serverUrl: "ws://localhost:3002",
      deviceName: "test-host",
      deviceVersion: "1.0.0",
      commandTarget,
      actionTarget,
    });
    // 预先注册（applyTenantId 创建 client，但不调用 connect）
    lifecycle.applyTenantId(TID);
    const fetchImpl = vi.fn();
    const keychain = makeKeychain();
    const ipc = makeIpcMain();
    registerIpcHandlers(ipc, capabilities, makeRegistrationPayload(), lifecycle, keychain);

    const result = await ipc.invoke("desktop:device:register", makeEvent(fetchImpl));

    expect(result).toEqual({ ok: true, tenantId: TID });
    expect(fetchImpl).not.toHaveBeenCalled();
    // 确保 Bridge 连接
    expect(instances.length).toBe(1);
    expect(instances[0].connect).toHaveBeenCalledTimes(1);
  });

  it("响应 deviceId 与本机身份不符时返回 device_mismatch 且不回填", async () => {
    const identity = makeIdentity(null);
    const lifecycle = new DesktopBridgeLifecycle(identity, {
      serverUrl: "ws://localhost:3002",
      deviceName: "test-host",
      deviceVersion: "1.0.0",
      commandTarget,
      actionTarget,
    });
    const fetchImpl = vi
      .fn()
      .mockResolvedValue(
        new Response(
          JSON.stringify({ ok: true, data: { deviceId: "evil-device", tenantId: TID } }),
        ),
      );
    const keychain = makeKeychain();
    const ipc = makeIpcMain();
    registerIpcHandlers(ipc, capabilities, makeRegistrationPayload(), lifecycle, keychain);

    const result = await ipc.invoke("desktop:device:register", makeEvent(fetchImpl));

    expect(result.ok).toBe(false);
    expect((result as { code: string }).code).toBe("device_mismatch");
    expect(lifecycle.isRegistered()).toBe(false);
    expect(keychain.set).not.toHaveBeenCalled();
  });

  it("响应 tenantId 非法时返回 invalid_tenant 且不回填", async () => {
    const identity = makeIdentity(null);
    const lifecycle = new DesktopBridgeLifecycle(identity, {
      serverUrl: "ws://localhost:3002",
      deviceName: "test-host",
      deviceVersion: "1.0.0",
      commandTarget,
      actionTarget,
    });
    const fetchImpl = vi.fn().mockResolvedValue(
      new Response(
        JSON.stringify({
          ok: true,
          data: { deviceId: identity.deviceId, tenantId: "not-a-uuid" },
        }),
      ),
    );
    const keychain = makeKeychain();
    const ipc = makeIpcMain();
    registerIpcHandlers(ipc, capabilities, makeRegistrationPayload(), lifecycle, keychain);

    const result = await ipc.invoke("desktop:device:register", makeEvent(fetchImpl));

    expect(result.ok).toBe(false);
    expect((result as { code: string }).code).toBe("invalid_tenant");
    expect(lifecycle.isRegistered()).toBe(false);
    expect(keychain.set).not.toHaveBeenCalled();
  });

  it("fetch 网络失败返回 network_error，保持 disconnected 可重试", async () => {
    const identity = makeIdentity(null);
    const lifecycle = new DesktopBridgeLifecycle(identity, {
      serverUrl: "ws://localhost:3002",
      deviceName: "test-host",
      deviceVersion: "1.0.0",
      commandTarget,
      actionTarget,
    });
    const fetchImpl = vi.fn().mockRejectedValue(new Error("ECONNREFUSED"));
    const keychain = makeKeychain();
    const ipc = makeIpcMain();
    registerIpcHandlers(ipc, capabilities, makeRegistrationPayload(), lifecycle, keychain);

    const result = await ipc.invoke("desktop:device:register", makeEvent(fetchImpl));

    expect(result.ok).toBe(false);
    expect((result as { code: string }).code).toBe("network_error");
    expect(lifecycle.isRegistered()).toBe(false);
    expect(lifecycle.getState()).toBe("disconnected");
  });

  it("首次持久化失败返回 persist_error 且保持未注册；重试必须重新 fetch 并再次持久化成功后才连接", async () => {
    const identity = makeIdentity(null);
    const lifecycle = new DesktopBridgeLifecycle(identity, {
      serverUrl: "ws://localhost:3002",
      deviceName: "test-host",
      deviceVersion: "1.0.0",
      commandTarget,
      actionTarget,
    });
    const fetchImpl = vi
      .fn()
      .mockImplementation(() =>
        Promise.resolve(
          new Response(
            JSON.stringify({ ok: true, data: { deviceId: identity.deviceId, tenantId: TID } }),
          ),
        ),
      );
    const keychain = makeKeychain();
    // 首次保存身份时 Keychain 写入失败（本地安全存储故障），后续成功
    keychain.set.mockRejectedValueOnce(new Error("keychain deny"));
    const ipc = makeIpcMain();
    registerIpcHandlers(ipc, capabilities, makeRegistrationPayload(), lifecycle, keychain);

    // 第一次：持久化失败 → persist_error，且内存身份 / Bridge 生命周期必须保持未注册
    const first = await ipc.invoke("desktop:device:register", makeEvent(fetchImpl));
    expect(first.ok).toBe(false);
    expect((first as { code: string }).code).toBe("persist_error");
    expect(lifecycle.isRegistered()).toBe(false);
    expect(lifecycle.getIdentity().tenantId).toBeNull();
    expect(lifecycle.getState()).toBe("disconnected");
    // 未创建 / 未连接 Bridge client
    expect(instances.length).toBe(0);

    // 第二次：绝不能凭内存态伪造成功短路，必须重新走真实注册端点并再次持久化
    const second = await ipc.invoke("desktop:device:register", makeEvent(fetchImpl));
    expect(fetchImpl).toHaveBeenCalledTimes(2);
    // 首次在 device-id 镜像写入即失败；重试成功后完整身份只作为最终提交标记写入一次。
    expect(keychain.set).toHaveBeenCalledTimes(3);
    const identityKeySets = keychain.set.mock.calls.filter(([k]) => k === DEVICE_IDENTITY_KEY);
    expect(identityKeySets.length).toBe(1);
    expect(second).toEqual({ ok: true, tenantId: TID });
    expect(lifecycle.isRegistered()).toBe(true);
    expect(lifecycle.getIdentity().tenantId).toBe(TID);
    // 仅重试成功后连接一次，不得先于持久化连接
    expect(instances.length).toBe(1);
    expect(instances[0].connect).toHaveBeenCalledTimes(1);
  });
});

describe("registerIpcHandlers (Bridge channel 无条件注册 + 动态读取)", () => {
  beforeEach(() => {
    instances.length = 0;
  });

  afterEach(() => {
    vi.clearAllMocks();
  });

  it("bridge:getState/connect/disconnect/onStateChange 全部无条件注册", async () => {
    const identity = makeIdentity(null);
    const lifecycle = new DesktopBridgeLifecycle(identity, {
      serverUrl: "ws://localhost:3002",
      deviceName: "test-host",
      deviceVersion: "1.0.0",
      commandTarget,
      actionTarget,
    });
    const ipc = makeIpcMain();
    registerIpcHandlers(ipc, capabilities, makeRegistrationPayload(), lifecycle, makeKeychain());

    for (const channel of [
      "desktop:bridge:getState",
      "desktop:bridge:connect",
      "desktop:bridge:disconnect",
      "desktop:bridge:onStateChange",
    ]) {
      expect(ipc.handlers.has(channel)).toBe(true);
    }
    // 未注册时 getState 返回 disconnected
    expect(await ipc.invoke("desktop:bridge:getState")).toBe("disconnected");
  });

  it("bridge:connect 动态读取 lifecycle 创建并连接 client", async () => {
    const identity = makeIdentity(TID);
    const lifecycle = new DesktopBridgeLifecycle(identity, {
      serverUrl: "ws://localhost:3002",
      deviceName: "test-host",
      deviceVersion: "1.0.0",
      commandTarget,
      actionTarget,
    });
    const ipc = makeIpcMain();
    registerIpcHandlers(ipc, capabilities, makeRegistrationPayload(), lifecycle, makeKeychain());

    expect(await ipc.invoke("desktop:bridge:connect")).toBe(true);
    expect(instances.length).toBe(1);
    expect(instances[0].connect).toHaveBeenCalledTimes(1);
  });

  it("cancelAi 动态读取 lifecycle 当前 client", async () => {
    const identity = makeIdentity(TID);
    const lifecycle = new DesktopBridgeLifecycle(identity, {
      serverUrl: "ws://localhost:3002",
      deviceName: "test-host",
      deviceVersion: "1.0.0",
      commandTarget,
      actionTarget,
    });
    const ipc = makeIpcMain();
    // 传入假 browserController 启用 browser 分支
    const fakeBrowserController = {} as never;
    registerIpcHandlers(
      ipc,
      capabilities,
      makeRegistrationPayload(),
      lifecycle,
      makeKeychain(),
      undefined,
      fakeBrowserController,
    );
    lifecycle.connect();
    // invoke 首参为 IpcMainEvent（fake 直接透传）
    expect(await ipc.invoke("desktop:browser:cancelAi", {}, "thread-1")).toBe(true);
    expect(instances[0].cancelAndTakeOver).toHaveBeenCalledWith("thread-1");
  });

  it("device:getRegistration 返回 registration payload", async () => {
    const lifecycle = new DesktopBridgeLifecycle(makeIdentity(null), {
      serverUrl: "ws://localhost:3002",
      deviceName: "test-host",
      deviceVersion: "1.0.0",
      commandTarget,
      actionTarget,
    });
    const ipc = makeIpcMain();
    registerIpcHandlers(ipc, capabilities, makeRegistrationPayload(), lifecycle, makeKeychain());

    const reg = await ipc.invoke("desktop:device:getRegistration");
    expect(reg).toEqual(makeRegistrationPayload());
  });
});
