import { type ConnectionState, ConnectionStateMachine } from "@/lib/desktop/connection-state";
import { describe, expect, it } from "vitest";

describe("ConnectionStateMachine 初始状态", () => {
  it("初始状态为 disconnected", () => {
    const sm = new ConnectionStateMachine();
    expect(sm.getState()).toBe("disconnected");
  });
});

describe("合法状态转换", () => {
  it("disconnected → connecting (connect)", () => {
    const sm = new ConnectionStateMachine();
    expect(sm.transition({ type: "connect" })).toBe("connecting");
  });

  it("connecting → connected (connected)", () => {
    const sm = new ConnectionStateMachine();
    sm.transition({ type: "connect" });
    expect(sm.transition({ type: "connected" })).toBe("connected");
  });

  it("connecting → disconnected (disconnect)", () => {
    const sm = new ConnectionStateMachine();
    sm.transition({ type: "connect" });
    expect(sm.transition({ type: "disconnect" })).toBe("disconnected");
  });

  it("connected → authenticated (authenticated)", () => {
    const sm = new ConnectionStateMachine();
    sm.transition({ type: "connect" });
    sm.transition({ type: "connected" });
    expect(sm.transition({ type: "authenticated" })).toBe("authenticated");
  });

  it("connected → disconnected (disconnect)", () => {
    const sm = new ConnectionStateMachine();
    sm.transition({ type: "connect" });
    sm.transition({ type: "connected" });
    expect(sm.transition({ type: "disconnect" })).toBe("disconnected");
  });

  it("connected → revoked (revoke)", () => {
    const sm = new ConnectionStateMachine();
    sm.transition({ type: "connect" });
    sm.transition({ type: "connected" });
    expect(sm.transition({ type: "revoke" })).toBe("revoked");
  });

  it("connected → protocol_mismatch (protocol_mismatch)", () => {
    const sm = new ConnectionStateMachine();
    sm.transition({ type: "connect" });
    sm.transition({ type: "connected" });
    expect(sm.transition({ type: "protocol_mismatch" })).toBe("protocol_mismatch");
  });

  it("authenticated → disconnected (disconnect)", () => {
    const sm = new ConnectionStateMachine();
    sm.transition({ type: "connect" });
    sm.transition({ type: "connected" });
    sm.transition({ type: "authenticated" });
    expect(sm.transition({ type: "disconnect" })).toBe("disconnected");
  });

  it("authenticated → revoked (revoke)", () => {
    const sm = new ConnectionStateMachine();
    sm.transition({ type: "connect" });
    sm.transition({ type: "connected" });
    sm.transition({ type: "authenticated" });
    expect(sm.transition({ type: "revoke" })).toBe("revoked");
  });

  it("disconnected → reconnecting (reconnect)", () => {
    const sm = new ConnectionStateMachine();
    expect(sm.transition({ type: "reconnect" })).toBe("reconnecting");
  });

  it("reconnecting → connected (reconnect_success)", () => {
    const sm = new ConnectionStateMachine();
    sm.transition({ type: "reconnect" });
    expect(sm.transition({ type: "reconnect_success" })).toBe("connected");
  });

  it("reconnecting → disconnected (reconnect_fail)", () => {
    const sm = new ConnectionStateMachine();
    sm.transition({ type: "reconnect" });
    expect(sm.transition({ type: "reconnect_fail" })).toBe("disconnected");
  });

  it("revoked → disconnected (disconnect)", () => {
    const sm = new ConnectionStateMachine();
    sm.transition({ type: "connect" });
    sm.transition({ type: "connected" });
    sm.transition({ type: "revoke" });
    expect(sm.transition({ type: "disconnect" })).toBe("disconnected");
  });

  it("protocol_mismatch → disconnected (disconnect)", () => {
    const sm = new ConnectionStateMachine();
    sm.transition({ type: "connect" });
    sm.transition({ type: "connected" });
    sm.transition({ type: "protocol_mismatch" });
    expect(sm.transition({ type: "disconnect" })).toBe("disconnected");
  });
});

describe("非法状态转换抛出错误", () => {
  it("disconnected → connected 抛错", () => {
    const sm = new ConnectionStateMachine();
    expect(() => sm.transition({ type: "connected" })).toThrow();
  });

  it("disconnected → authenticated 抛错", () => {
    const sm = new ConnectionStateMachine();
    expect(() => sm.transition({ type: "authenticated" })).toThrow();
  });

  it("connecting → authenticated 抛错", () => {
    const sm = new ConnectionStateMachine();
    sm.transition({ type: "connect" });
    expect(() => sm.transition({ type: "authenticated" })).toThrow();
  });

  it("disconnected → revoke 抛错", () => {
    const sm = new ConnectionStateMachine();
    expect(() => sm.transition({ type: "revoke" })).toThrow();
  });

  it("authenticated → connected 抛错", () => {
    const sm = new ConnectionStateMachine();
    sm.transition({ type: "connect" });
    sm.transition({ type: "connected" });
    sm.transition({ type: "authenticated" });
    expect(() => sm.transition({ type: "connected" })).toThrow();
  });

  it("revoked → connecting 抛错（撤销后必须手动重连）", () => {
    const sm = new ConnectionStateMachine();
    sm.transition({ type: "connect" });
    sm.transition({ type: "connected" });
    sm.transition({ type: "revoke" });
    expect(() => sm.transition({ type: "connect" })).toThrow();
  });

  it("reconnecting → authenticated 抛错", () => {
    const sm = new ConnectionStateMachine();
    sm.transition({ type: "reconnect" });
    expect(() => sm.transition({ type: "authenticated" })).toThrow();
  });
});

describe("canSendRpc()", () => {
  it("只有 authenticated 返回 true", () => {
    const sm = new ConnectionStateMachine();
    expect(sm.canSendRpc()).toBe(false);
    sm.transition({ type: "connect" });
    expect(sm.canSendRpc()).toBe(false);
    sm.transition({ type: "connected" });
    expect(sm.canSendRpc()).toBe(false);
    sm.transition({ type: "authenticated" });
    expect(sm.canSendRpc()).toBe(true);
    sm.transition({ type: "disconnect" });
    expect(sm.canSendRpc()).toBe(false);
  });
});

describe("isOnline()", () => {
  it("connected 和 authenticated 返回 true", () => {
    const sm = new ConnectionStateMachine();
    expect(sm.isOnline()).toBe(false);
    sm.transition({ type: "connect" });
    expect(sm.isOnline()).toBe(false);
    sm.transition({ type: "connected" });
    expect(sm.isOnline()).toBe(true);
    sm.transition({ type: "authenticated" });
    expect(sm.isOnline()).toBe(true);
    sm.transition({ type: "disconnect" });
    expect(sm.isOnline()).toBe(false);
  });

  it("revoked 返回 false", () => {
    const sm = new ConnectionStateMachine();
    sm.transition({ type: "connect" });
    sm.transition({ type: "connected" });
    sm.transition({ type: "revoke" });
    expect(sm.isOnline()).toBe(false);
  });

  it("protocol_mismatch 返回 false", () => {
    const sm = new ConnectionStateMachine();
    sm.transition({ type: "connect" });
    sm.transition({ type: "connected" });
    sm.transition({ type: "protocol_mismatch" });
    expect(sm.isOnline()).toBe(false);
  });

  it("reconnecting 返回 false", () => {
    const sm = new ConnectionStateMachine();
    sm.transition({ type: "reconnect" });
    expect(sm.isOnline()).toBe(false);
  });
});

describe("subscribe()", () => {
  it("状态变化时触发回调", () => {
    const sm = new ConnectionStateMachine();
    const states: ConnectionState[] = [];
    sm.subscribe((state) => states.push(state));
    sm.transition({ type: "connect" });
    expect(states).toEqual(["connecting"]);
    sm.transition({ type: "connected" });
    expect(states).toEqual(["connecting", "connected"]);
  });

  it("回调传入 prevState", () => {
    const sm = new ConnectionStateMachine();
    const pairs: Array<{ state: ConnectionState; prev: ConnectionState }> = [];
    sm.subscribe((state, prev) => pairs.push({ state, prev }));
    sm.transition({ type: "connect" });
    sm.transition({ type: "connected" });
    expect(pairs).toEqual([
      { state: "connecting", prev: "disconnected" },
      { state: "connected", prev: "connecting" },
    ]);
  });

  it("取消订阅后不再触发", () => {
    const sm = new ConnectionStateMachine();
    const states: ConnectionState[] = [];
    const unsubscribe = sm.subscribe((state) => states.push(state));
    sm.transition({ type: "connect" });
    expect(states.length).toBe(1);
    unsubscribe();
    sm.transition({ type: "connected" });
    expect(states.length).toBe(1);
  });

  it("多个订阅者都收到回调", () => {
    const sm = new ConnectionStateMachine();
    const states1: ConnectionState[] = [];
    const states2: ConnectionState[] = [];
    sm.subscribe((s) => states1.push(s));
    sm.subscribe((s) => states2.push(s));
    sm.transition({ type: "connect" });
    expect(states1).toEqual(["connecting"]);
    expect(states2).toEqual(["connecting"]);
  });

  it("非法转换不触发回调", () => {
    const sm = new ConnectionStateMachine();
    const states: ConnectionState[] = [];
    sm.subscribe((s) => states.push(s));
    expect(() => sm.transition({ type: "connected" })).toThrow();
    expect(states.length).toBe(0);
  });
});
