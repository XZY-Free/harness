import {
  type ControlEvent,
  publishControlEvent,
  resetControlEventBus,
  subscribeControlEvents,
} from "@/lib/desktop-bridge/control-event-bus";
import {
  controlBrandInvalidatedMessageSchema,
  controlUpdateHintMessageSchema,
  parseServerMessage,
  serializeMessage,
} from "@/lib/desktop/bridge-messages";
import { afterEach, describe, expect, it, vi } from "vitest";

afterEach(() => resetControlEventBus());

describe("Control Event Bus", () => {
  it("发布后同步扇出到全部订阅者", () => {
    const a = vi.fn();
    const b = vi.fn();
    subscribeControlEvents(a);
    subscribeControlEvents(b);
    const event: ControlEvent = {
      type: "control_brand_invalidated",
      revision: 3,
      etag: '"3:0"',
      occurredAt: 1,
    };
    publishControlEvent(event);
    expect(a).toHaveBeenCalledWith(event);
    expect(b).toHaveBeenCalledWith(event);
  });

  it("单个监听器异常不击穿其他监听器", () => {
    const bad = vi.fn(() => {
      throw new Error("boom");
    });
    const good = vi.fn();
    subscribeControlEvents(bad);
    subscribeControlEvents(good);
    publishControlEvent({
      type: "control_update_hint",
      latestVersion: "1.2.0",
      occurredAt: 2,
    });
    expect(bad).toHaveBeenCalledTimes(1);
    expect(good).toHaveBeenCalledTimes(1);
  });

  it("取消订阅后不再接收", () => {
    const listener = vi.fn();
    const unsubscribe = subscribeControlEvents(listener);
    unsubscribe();
    publishControlEvent({
      type: "control_brand_invalidated",
      revision: 1,
      etag: '"1:0"',
      occurredAt: 3,
    });
    expect(listener).not.toHaveBeenCalled();
  });
});

describe("控制事件协议 schema 与序列化", () => {
  it("brand_invalidated 与 update_hint 均属于 server 消息联合", () => {
    const brand = controlBrandInvalidatedMessageSchema.parse({
      type: "control_brand_invalidated",
      revision: 4,
      etag: '"4:1"',
      occurredAt: 10,
    });
    const hint = controlUpdateHintMessageSchema.parse({
      type: "control_update_hint",
      latestVersion: "2.0.0",
      feedUrl: "https://updates.example.test/feed.json",
      occurredAt: 11,
    });
    expect(parseServerMessage(JSON.parse(serializeMessage(brand)))).toEqual({
      ok: true,
      message: brand,
    });
    expect(parseServerMessage(JSON.parse(serializeMessage(hint)))).toEqual({
      ok: true,
      message: hint,
    });
  });

  it("update_hint 的 feedUrl 可选", () => {
    const hint = controlUpdateHintMessageSchema.parse({
      type: "control_update_hint",
      latestVersion: "2.0.1",
      occurredAt: 12,
    });
    expect(hint.feedUrl).toBeUndefined();
  });
});
