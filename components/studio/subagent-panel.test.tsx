import { act, cleanup, render, screen, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

/**
 * 12-P1-3：subagent-panel SSE 事件驱动刷新测试。
 *
 * 验证：
 * - 挂载后拉一次初始数据
 * - 收到 subagent.spawned SSE 事件 → 触发 refresh 拉最新数据
 * - 收到无关事件（如 task.started）→ 不 refresh
 * - 不再有 setInterval 轮询（SSE 断线降级由 useThreadEvents 处理）
 */

// EventSource mock：捕获 onmessage，测试手动触发事件
const esInstances: MockEventSource[] = [];
class MockEventSource {
  url: string;
  onmessage: ((ev: { data: string }) => void) | null = null;
  onopen: (() => void) | null = null;
  onerror: (() => void) | null = null;
  closed = false;
  constructor(url: string) {
    this.url = url;
    esInstances.push(this);
  }
  close() {
    this.closed = true;
  }
}

vi.stubGlobal("EventSource", MockEventSource);

// fetch mock
const fetchMock = vi.fn();
vi.stubGlobal("fetch", fetchMock);

import { SubagentPanel } from "./subagent-panel";

beforeEach(() => {
  esInstances.length = 0;
  fetchMock.mockReset();
  fetchMock.mockResolvedValue(
    new Response(JSON.stringify({ data: { subagents: [] } }), { status: 200 }),
  );
});

afterEach(() => {
  cleanup();
});

function emitSse(es: MockEventSource, data: unknown) {
  act(() => {
    es.onmessage?.({ data: JSON.stringify(data) });
  });
}

describe("SubagentPanel 12-P1-3 SSE 驱动刷新", () => {
  it("挂载后拉一次初始数据", async () => {
    render(<SubagentPanel threadId="t1" />);
    await waitFor(() => {
      expect(screen.getByText("当前 thread 无子代理。")).toBeTruthy();
    });
    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(fetchMock).toHaveBeenCalledWith("/studio/api/threads/t1/subagents", {
      cache: "no-store",
    });
  });

  it("收到 subagent.spawned 事件 → refresh 拉最新数据", async () => {
    render(<SubagentPanel threadId="t1" />);
    await waitFor(() => {
      expect(screen.getByText("当前 thread 无子代理。")).toBeTruthy();
    });
    expect(fetchMock).toHaveBeenCalledTimes(1);

    // 设置第二次 fetch 返回一条子代理（用 mockImplementation 保证后续 fetch 都返回这个）
    fetchMock.mockImplementation(() =>
      Promise.resolve(
        new Response(
          JSON.stringify({
            data: {
              subagents: [
                {
                  id: "sa1",
                  definitionId: "d1",
                  goal: "写测试",
                  status: "running",
                  writeScope: null,
                  resultSummary: null,
                  outputArtifactId: null,
                  transcriptPath: null,
                  errorMessage: null,
                  startedAt: null,
                  finishedAt: null,
                  createdAt: "2026-06-26T00:00:00Z",
                },
              ],
            },
          }),
          { status: 200 },
        ),
      ),
    );

    const es = esInstances[0];
    if (!es) throw new Error("es not created");
    emitSse(es, {
      kind: "event",
      threadId: "t1",
      type: "subagent.spawned",
      payload: { runId: "sa1" },
      sequence: 1,
    });

    await waitFor(() => {
      expect(fetchMock).toHaveBeenCalledTimes(2);
    });
    // 文本被拆成 "目标: " + "写测试"，用 matchByText 函数匹配
    expect(
      screen.getByText((_content, element) => element?.textContent === "目标: 写测试"),
    ).toBeTruthy();
  });

  it("收到无关事件（task.started）→ 不 refresh", async () => {
    render(<SubagentPanel threadId="t1" />);
    await waitFor(() => {
      expect(screen.getByText("当前 thread 无子代理。")).toBeTruthy();
    });
    expect(fetchMock).toHaveBeenCalledTimes(1);

    const es = esInstances[0];
    if (!es) throw new Error("es not created");
    emitSse(es, {
      kind: "event",
      threadId: "t1",
      type: "task.started",
      payload: {},
      sequence: 2,
    });

    // 等待片刻确认无额外 fetch
    await new Promise((r) => setTimeout(r, 50));
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });
});
