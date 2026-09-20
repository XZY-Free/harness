import { SSE_BUFFER_SIZE } from "@/lib/conversations/sse-transport";
import type { ThreadTransientGeneration } from "@/lib/runtime/thread-generation";
import { describe, expect, it, vi } from "vitest";
import {
  MAX_BUFFERED_EVENTS_PER_THREAD,
  publishThreadTransientEvent,
  subscribeThreadTransientEvents,
} from "./transient-event-bus";

/**
 * A11：transient 事件必须携带执行代际标记，且订阅必须经**初始化 barrier**：
 * drain 只把一次性 buffer 搬进暂存区，`release(accept)` 之后才投递（按 exact tuple 过滤）。
 * 本文件覆盖总线的一次性投递语义与 barrier；代际的逐项复核由
 * `lib/runtime/__tests__/transient-generation-isolation.db.test.ts` 覆盖。
 */
const TRANSIENT_GENERATION: ThreadTransientGeneration = {
  invocationId: "invocation-1",
  attemptId: "attempt-1",
  ownershipId: "ownership-1",
  leaseEpoch: "1",
};

function makeEvent(
  threadId: string,
  transientId: string,
  delta: string,
): {
  threadId: string;
  transientId: string;
  turnId: string;
  generation: ThreadTransientGeneration;
  type: string;
  occurredAt: string;
  payload: { delta: string };
} {
  return {
    threadId,
    transientId,
    turnId: "turn-1",
    generation: TRANSIENT_GENERATION,
    type: "response.delta",
    occurredAt: "2026-07-21T00:00:00.000Z",
    payload: { delta },
  };
}

describe("thread transient event bus", () => {
  it("有活跃 listener 时 publish 实时投递；unsubscribe 后新 listener 不得重放这批已实时投递事件", () => {
    const current: string[] = [];
    const sub = subscribeThreadTransientEvents("thread-1", (event) => {
      current.push(event.payload.delta as string);
    });
    sub.release(() => true);

    // 已有活跃 listener：只实时投递，不入 buffer。
    publishThreadTransientEvent(makeEvent("thread-1", "delta-1", "你"));
    sub.unsubscribe();

    // 新 listener 不得重放已实时投递的历史增量（一次性语义）。
    const replayed: string[] = [];
    const stopReplay = subscribeThreadTransientEvents("thread-1", (event) => {
      replayed.push(event.payload.delta as string);
    });
    stopReplay.release(() => true);
    stopReplay.unsubscribe();

    expect(current).toEqual(["你"]);
    expect(replayed).toEqual([]);
  });

  it("publish 发生在首 listener 之前→首 listener 收到；第二 listener 不得再次收到", () => {
    // 无 listener 期间产生的事件进入一次性 buffer。
    publishThreadTransientEvent(makeEvent("thread-2", "delta-1", "你"));

    const first: string[] = [];
    const firstSub = subscribeThreadTransientEvents("thread-2", (event) => {
      first.push(event.payload.delta as string);
    });
    // A11：drain 只进暂存区，barrier 打开前不得投递。
    expect(first).toEqual([]);
    expect(firstSub.staged.map((event) => event.payload.delta)).toEqual(["你"]);
    firstSub.release(() => true);
    firstSub.unsubscribe();

    // 第二 listener 不得再次看到已 drain 的历史增量。
    const second: string[] = [];
    const secondSub = subscribeThreadTransientEvents("thread-2", (event) => {
      second.push(event.payload.delta as string);
    });
    secondSub.release(() => true);
    secondSub.unsubscribe();

    expect(first).toEqual(["你"]);
    expect(second).toEqual([]);
  });

  it("barrier 打开前的实时事件同样只暂存；release 按 accept 过滤，拒绝的暂存不投递", () => {
    const threadId = `thread-barrier-${Date.now()}`;
    const received: string[] = [];
    const sub = subscribeThreadTransientEvents(threadId, (event) => {
      received.push(event.payload.delta as string);
    });

    // barrier 未打开：buffer 与实时事件都只进暂存。
    publishThreadTransientEvent(makeEvent(threadId, "delta-1", "旧"));
    publishThreadTransientEvent(makeEvent(threadId, "delta-2", "代"));
    expect(received).toEqual([]);
    expect(sub.staged.map((event) => event.transientId)).toEqual(["delta-1", "delta-2"]);

    // release 时被拒的暂存事件（旧代际）不得进入正文。
    sub.release((event) => event.transientId !== "delta-1");
    // 之后的实时事件同样按同一规则过滤。
    publishThreadTransientEvent(makeEvent(threadId, "delta-3", "新"));
    sub.unsubscribe();

    expect(received).toEqual(["代", "新"]);
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
    const firstSub = subscriber.subscribeThreadTransientEvents(threadId, (event) => {
      first.push(event.payload.delta as string);
    });
    firstSub.release(() => true);
    firstSub.unsubscribe();

    // 第二个跨实例 listener 不得再次收到已 drain 的历史。
    const second: string[] = [];
    const secondSub = subscriber.subscribeThreadTransientEvents(threadId, (event) => {
      second.push(event.payload.delta as string);
    });
    secondSub.release(() => true);
    secondSub.unsubscribe();

    // 实时 publish 也必须跨实例到达。
    const live: string[] = [];
    const liveSub = subscriber.subscribeThreadTransientEvents(threadId, (event) => {
      live.push(event.payload.delta as string);
    });
    liveSub.release(() => true);
    publisher.publishThreadTransientEvent(makeEvent(threadId, "delta-2", "好"));
    liveSub.unsubscribe();

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
    const sub = subscribeThreadTransientEvents(threadId, (event) => {
      received.push(event.payload.delta as string);
    });
    sub.release(() => true);
    sub.unsubscribe();

    // 只保留最近上限条，且严格小于 SSE_BUFFER_SIZE（为 stream.resumed/backlog 留余量）。
    expect(received.length).toBe(MAX_BUFFERED_EVENTS_PER_THREAD);
    expect(received.length).toBeLessThan(SSE_BUFFER_SIZE);
    // 保留的是最近 MAX 条（递增序证明截断发生在头部）。
    expect(received[0]).toBe(`c${SSE_BUFFER_SIZE * 3 - MAX_BUFFERED_EVENTS_PER_THREAD}`);

    // 已 drain，后续 listener 不得再看到。
    const second: string[] = [];
    const secondSub = subscribeThreadTransientEvents(threadId, (event) => {
      second.push(event.payload.delta as string);
    });
    secondSub.release(() => true);
    secondSub.unsubscribe();
    expect(second).toEqual([]);
  });

  it("barrier 打开前的暂存同样有界（防止基线读取期间无限堆积）", () => {
    const threadId = `thread-stage-capped-${Date.now()}`;
    const sub = subscribeThreadTransientEvents(threadId, () => {});
    for (let i = 0; i < MAX_BUFFERED_EVENTS_PER_THREAD * 2; i++) {
      publishThreadTransientEvent(makeEvent(threadId, `delta-${i}`, `c${i}`));
    }
    expect(sub.staged.length).toBe(MAX_BUFFERED_EVENTS_PER_THREAD);
    // 保留最近 MAX 条。
    expect(sub.staged[0]?.transientId).toBe(
      `delta-${MAX_BUFFERED_EVENTS_PER_THREAD * 2 - MAX_BUFFERED_EVENTS_PER_THREAD}`,
    );
    sub.unsubscribe();
  });
});
