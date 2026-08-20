import { SSE_BUFFER_SIZE } from "@/lib/conversations/sse-transport";
import { describe, expect, it, vi } from "vitest";
import {
  MAX_BUFFERED_EVENTS_PER_THREAD,
  publishThreadTransientEvent,
  subscribeThreadTransientEvents,
} from "./transient-event-bus";

function makeEvent(
  threadId: string,
  transientId: string,
  delta: string,
): {
  threadId: string;
  transientId: string;
  turnId: string;
  type: string;
  occurredAt: string;
  payload: { delta: string };
} {
  return {
    threadId,
    transientId,
    turnId: "turn-1",
    type: "response.delta",
    occurredAt: "2026-07-21T00:00:00.000Z",
    payload: { delta },
  };
}

describe("thread transient event bus", () => {
  it("有活跃 listener 时 publish 实时投递；unsubscribe 后新 listener 不得重放这批已实时投递事件", () => {
    const current: string[] = [];
    const unsubscribe = subscribeThreadTransientEvents("thread-1", (event) => {
      current.push(event.payload.delta as string);
    });

    // 已有活跃 listener：只实时投递，不入 buffer。
    publishThreadTransientEvent(makeEvent("thread-1", "delta-1", "你"));
    unsubscribe();

    // 新 listener 不得重放已实时投递的历史增量（一次性语义）。
    const replayed: string[] = [];
    const stopReplay = subscribeThreadTransientEvents("thread-1", (event) => {
      replayed.push(event.payload.delta as string);
    });
    stopReplay();

    expect(current).toEqual(["你"]);
    expect(replayed).toEqual([]);
  });

  it("publish 发生在首 listener 之前→首 listener 收到；第二 listener 不得再次收到", () => {
    // 无 listener 期间产生的事件进入一次性 buffer。
    publishThreadTransientEvent(makeEvent("thread-2", "delta-1", "你"));

    const first: string[] = [];
    const stopFirst = subscribeThreadTransientEvents("thread-2", (event) => {
      first.push(event.payload.delta as string);
    });
    stopFirst();

    // 第二 listener 不得再次看到已 drain 的历史增量。
    const second: string[] = [];
    const stopSecond = subscribeThreadTransientEvents("thread-2", (event) => {
      second.push(event.payload.delta as string);
    });
    stopSecond();

    expect(first).toEqual(["你"]);
    expect(second).toEqual([]);
  });

  it("两个独立模块实例（publish 与 subscribe 分离）共享并一次性 drain", async () => {
    // 唯一 threadId，避免与其它用例的全局状态互扰。
    const threadId = `thread-shared-${Date.now()}`;

    // 重新求值两次，得到两个不同模块实例（模拟 Next dev 下 publish/subscribe 落在不同 bundle）。
    vi.resetModules();
    const publisher = await import("./transient-event-bus");
    vi.resetModules();
    const subscriber = await import("./transient-event-bus");

    // 先 publish、后 subscribe：buffer replay 必须跨实例可见，且一次性。
    publisher.publishThreadTransientEvent(makeEvent(threadId, "delta-1", "你"));

    const first: string[] = [];
    const stopFirst = subscriber.subscribeThreadTransientEvents(threadId, (event) => {
      first.push(event.payload.delta as string);
    });
    stopFirst();

    // 第二个跨实例 listener 不得再次收到已 drain 的历史。
    const second: string[] = [];
    const stopSecond = subscriber.subscribeThreadTransientEvents(threadId, (event) => {
      second.push(event.payload.delta as string);
    });
    stopSecond();

    // 实时 publish 也必须跨实例到达。
    publisher.publishThreadTransientEvent(makeEvent(threadId, "delta-2", "好"));
    const live: string[] = [];
    const stopLive = subscriber.subscribeThreadTransientEvents(threadId, (event) => {
      live.push(event.payload.delta as string);
    });
    stopLive();

    expect(first).toEqual(["你"]);
    expect(second).toEqual([]);
    expect(live).toEqual(["好"]);
  });

  it("大于安全上限的首订阅前 buffer 不会返回超过上限的事件，避免同步 replay 触发 SSE 背压", () => {
    const threadId = `thread-capped-${Date.now()}`;
    // 无 listener 期间塞入远超 SSE_BUFFER_SIZE 的增量。
    for (let i = 0; i < SSE_BUFFER_SIZE * 3; i++) {
      publishThreadTransientEvent(makeEvent(threadId, `delta-${i}`, `c${i}`));
    }

    const received: string[] = [];
    const stop = subscribeThreadTransientEvents(threadId, (event) => {
      received.push(event.payload.delta as string);
    });
    stop();

    // 只保留最近上限条，且严格小于 SSE_BUFFER_SIZE（为 stream.resumed/backlog 留余量）。
    expect(received.length).toBe(MAX_BUFFERED_EVENTS_PER_THREAD);
    expect(received.length).toBeLessThan(SSE_BUFFER_SIZE);
    // 保留的是最近 MAX 条（递增序证明截断发生在头部）。
    expect(received[0]).toBe(`c${SSE_BUFFER_SIZE * 3 - MAX_BUFFERED_EVENTS_PER_THREAD}`);

    // 已 drain，后续 listener 不得再看到。
    const second: string[] = [];
    const stopSecond = subscribeThreadTransientEvents(threadId, (event) => {
      second.push(event.payload.delta as string);
    });
    stopSecond();
    expect(second).toEqual([]);
  });
});
