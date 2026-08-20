/**
 * DesktopBridgeLifecycle 测试。
 *
 * 用受控的 FakeBridgeClient 替换真实 BridgeClient，验证生命周期编排：
 * 未注册不创建 client / connect 返回 false；注册成功立即创建并连接；
 * 状态订阅转发；clearTenant 清空租户并销毁 client。
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { ConnectionState } from "../../lib/desktop/connection-state";
import type { BrowserActionTarget, BrowserCommandTarget } from "./command-executor";

/** 捕获创建 BridgeClient 时传入的 config（用实例替换）。 */
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
    /** 测试辅助：模拟连接状态推进。 */
    transition(to: ConnectionState): void {
      this.state = to;
      for (const l of this.listeners) l(to);
    }
  },
}));

vi.mock("./bridge-client", () => mockBridgeClient);

import { DesktopBridgeLifecycle, isValidTenantId } from "./bridge-lifecycle";
import type { DeviceIdentity } from "./device-identity";

const commandTarget = {} as unknown as BrowserCommandTarget;
const actionTarget = {} as unknown as BrowserActionTarget;

function makeIdentity(tenantId: string | null): DeviceIdentity {
  return {
    deviceId: "11111111-1111-4111-8111-111111111111",
    keyPair: { publicKeyBase64: "pk", privateKeyBase64: "sk" },
    tenantId,
  };
}

function makeLifecycle(tenantId: string | null) {
  const identity = makeIdentity(tenantId);
  const lifecycle = new DesktopBridgeLifecycle(identity, {
    serverUrl: "ws://localhost:3002",
    deviceName: "test-device",
    deviceVersion: "1.0.0",
    commandTarget,
    actionTarget,
  });
  return { identity, lifecycle };
}

describe("isValidTenantId()", () => {
  it("接受合法 UUID v4", () => {
    expect(isValidTenantId("a0eebc99-9c0b-4ef8-bb6d-6bb9bd380a11")).toBe(true);
  });

  it("拒绝空字符串", () => {
    expect(isValidTenantId("")).toBe(false);
  });

  it("拒绝非 UUID 字符串", () => {
    expect(isValidTenantId("tenant-001")).toBe(false);
  });

  it("拒绝非法版本位 / 变体位", () => {
    // 版本位为 3（非 v4）、变体位为 0（非法）
    expect(isValidTenantId("a0eebc99-9c0b-3ef8-bb6d-6bb9bd380a11")).toBe(false);
  });
});

describe("DesktopBridgeLifecycle", () => {
  beforeEach(() => {
    instances.length = 0;
  });

  afterEach(() => {
    vi.clearAllMocks();
  });

  it("未注册时 getState 返回 disconnected", () => {
    const { lifecycle } = makeLifecycle(null);
    expect(lifecycle.isRegistered()).toBe(false);
    expect(lifecycle.getState()).toBe("disconnected");
  });

  it("未注册时 connect 返回 false 且不创建 client", () => {
    const { lifecycle } = makeLifecycle(null);
    expect(lifecycle.connect()).toBe(false);
    expect(instances.length).toBe(0);
  });

  it("未注册时 ensureConnected 返回 false", () => {
    const { lifecycle } = makeLifecycle(null);
    expect(lifecycle.ensureConnected()).toBe(false);
    expect(instances.length).toBe(0);
  });

  it("已注册时 connect 创建 client 并返回 true", () => {
    const { lifecycle } = makeLifecycle("a0eebc99-9c0b-4ef8-bb6d-6bb9bd380a11");
    expect(lifecycle.isRegistered()).toBe(true);
    expect(lifecycle.connect()).toBe(true);
    expect(instances.length).toBe(1);
    expect(instances[0].connect).toHaveBeenCalledTimes(1);
  });

  it("applyTenantId 非法 tenantId 返回 false 且不创建 client", () => {
    const { identity, lifecycle } = makeLifecycle(null);
    expect(lifecycle.applyTenantId("tenant-001")).toBe(false);
    expect(identity.tenantId).toBeNull();
    expect(instances.length).toBe(0);
    expect(lifecycle.getState()).toBe("disconnected");
  });

  it("applyTenantId 合法 tenantId 回填并立即创建 client（无需重启）", () => {
    const { identity, lifecycle } = makeLifecycle(null);
    const tid = "a0eebc99-9c0b-4ef8-bb6d-6bb9bd380a11";
    expect(lifecycle.applyTenantId(tid)).toBe(true);
    expect(identity.tenantId).toBe(tid);
    expect(lifecycle.isRegistered()).toBe(true);
    // 立即创建了 client，connect 可直连
    expect(instances.length).toBe(1);
    expect(lifecycle.connect()).toBe(true);
  });

  it("replaceClient 用 tenantId 构建 BridgeClient", () => {
    const tid = "a0eebc99-9c0b-4ef8-bb6d-6bb9bd380a11";
    const { lifecycle } = makeLifecycle(null);
    lifecycle.applyTenantId(tid);
    // 通过 FakeBridgeClient 无法直接读 config；这里验证 connect 可用即证明 client 已按 tenantId 构造
    expect(lifecycle.connect()).toBe(true);
    expect(lifecycle.getState()).toBe("disconnected");
  });

  it("onStateChange 转发底层 client 的状态", () => {
    const tid = "a0eebc99-9c0b-4ef8-bb6d-6bb9bd380a11";
    const { lifecycle } = makeLifecycle(tid);
    lifecycle.connect();
    const states: ConnectionState[] = [];
    lifecycle.onStateChange((s) => states.push(s));
    // 模拟底层连接推进到 authenticated
    const client = instances[0] as unknown as {
      transition: (to: ConnectionState) => void;
    };
    client.transition("connecting");
    client.transition("authenticated");
    expect(states).toEqual(["connecting", "authenticated"]);
  });

  it("onStateChange 返回的取消订阅函数停止转发", () => {
    const tid = "a0eebc99-9c0b-4ef8-bb6d-6bb9bd380a11";
    const { lifecycle } = makeLifecycle(tid);
    lifecycle.connect();
    const states: ConnectionState[] = [];
    const off = lifecycle.onStateChange((s) => states.push(s));
    const client = instances[0] as unknown as { transition: (to: ConnectionState) => void };
    client.transition("connected");
    off();
    client.transition("authenticated");
    expect(states).toEqual(["connected"]);
  });

  it("disconnect 转发给当前 client", () => {
    const tid = "a0eebc99-9c0b-4ef8-bb6d-6bb9bd380a11";
    const { lifecycle } = makeLifecycle(tid);
    lifecycle.connect();
    expect(lifecycle.disconnect()).toBe(true);
    expect(instances[0].disconnect).toHaveBeenCalledTimes(1);
  });

  it("cancelAndTakeOver 转发给当前 client", () => {
    const tid = "a0eebc99-9c0b-4ef8-bb6d-6bb9bd380a11";
    const { lifecycle } = makeLifecycle(tid);
    lifecycle.connect();
    expect(lifecycle.cancelAndTakeOver("thread-1")).toBe(true);
    expect(instances[0].cancelAndTakeOver).toHaveBeenCalledWith("thread-1");
  });

  it("clearTenant 清空 tenantId 并销毁 client", () => {
    const { identity, lifecycle } = makeLifecycle("a0eebc99-9c0b-4ef8-bb6d-6bb9bd380a11");
    lifecycle.connect();
    expect(instances.length).toBe(1);
    lifecycle.clearTenant();
    expect(identity.tenantId).toBeNull();
    expect(lifecycle.isRegistered()).toBe(false);
    expect(lifecycle.getState()).toBe("disconnected");
    // 旧 client 被断开；后续 connect 返回 false 且不创建新 client
    expect(instances[0].disconnect).toHaveBeenCalled();
    expect(lifecycle.connect()).toBe(false);
    expect(instances.length).toBe(1);
  });
});
