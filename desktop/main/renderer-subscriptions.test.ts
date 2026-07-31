import { describe, expect, it, vi } from "vitest";
import { RendererSubscriptions } from "./renderer-subscriptions";

class FakeSender {
  readonly id = 42;
  private destroyedListeners: Array<() => void> = [];

  once(event: "destroyed", listener: () => void): void {
    if (event === "destroyed") this.destroyedListeners.push(listener);
  }

  destroy(): void {
    for (const listener of this.destroyedListeners.splice(0)) listener();
  }

  get destroyedListenerCount(): number {
    return this.destroyedListeners.length;
  }
}

describe("RendererSubscriptions", () => {
  it("重复 replace 同一订阅时释放旧订阅且只监听一次 destroyed", () => {
    const subscriptions = new RendererSubscriptions();
    const sender = new FakeSender();
    const firstStop = vi.fn();
    const secondStop = vi.fn();

    subscriptions.replace(sender, "browser:thread-1", () => firstStop);
    subscriptions.replace(sender, "browser:thread-1", () => secondStop);

    expect(firstStop).toHaveBeenCalledOnce();
    expect(secondStop).not.toHaveBeenCalled();
    expect(sender.destroyedListenerCount).toBe(1);

    sender.destroy();
    expect(secondStop).toHaveBeenCalledOnce();
  });

  it("ensure 对同一 renderer 和 key 只创建一次订阅", () => {
    const subscriptions = new RendererSubscriptions();
    const sender = new FakeSender();
    const subscribe = vi.fn(() => vi.fn());

    subscriptions.ensure(sender, "browser-lock", subscribe);
    subscriptions.ensure(sender, "browser-lock", subscribe);

    expect(subscribe).toHaveBeenCalledOnce();
    expect(sender.destroyedListenerCount).toBe(1);
  });
});
