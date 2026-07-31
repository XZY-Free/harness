import { describe, expect, it } from "vitest";
import { publishThreadTransientEvent, subscribeThreadTransientEvents } from "./transient-event-bus";

describe("thread transient event bus", () => {
  it("向当前订阅者推送并向后加入的订阅者重放增量", () => {
    const current: string[] = [];
    const unsubscribe = subscribeThreadTransientEvents("thread-1", (event) => {
      current.push(event.payload.delta as string);
    });

    publishThreadTransientEvent({
      transientId: "delta-1",
      threadId: "thread-1",
      turnId: "turn-1",
      type: "response.delta",
      occurredAt: "2026-07-21T00:00:00.000Z",
      payload: { delta: "你" },
    });
    unsubscribe();

    const replayed: string[] = [];
    const stopReplay = subscribeThreadTransientEvents("thread-1", (event) => {
      replayed.push(event.payload.delta as string);
    });
    stopReplay();

    expect(current).toEqual(["你"]);
    expect(replayed).toEqual(["你"]);
  });
});
