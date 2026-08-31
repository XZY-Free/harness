import type { ClientTurn } from "@/lib/client/types";
import { act, cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { ThreadInput } from "./thread-input";

const agents = [{ id: "hr-agent", displayName: "人力助手" }];
let rejectSend = false;
const fetchMock = vi.fn(async (url: string, init?: RequestInit) => {
  if (url === "/api/models") return Response.json({ ok: true, data: { models: [] } });
  if (url.includes("/pending-inputs") && init?.method === "GET")
    return Response.json({ items: [], pending_queue_version_no: 1 });
  if (init?.method === "POST") return Response.json({}, { status: rejectSend ? 503 : 201 });
  throw new Error(`Unexpected request: ${url}`);
});
beforeEach(() => {
  rejectSend = false;
  fetchMock.mockClear();
  vi.stubGlobal("fetch", fetchMock);
  sessionStorage.clear();
});
afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});
const props = { threadId: "thread-1", latestTurn: null, availableAgents: agents };
async function chooseAgent() {
  fireEvent.click(screen.getByRole("button", { name: "优先助手" }));
  fireEvent.click(await screen.findByRole("button", { name: "人力助手" }));
}
async function send() {
  fireEvent.change(screen.getByRole("textbox", { name: "消息输入框" }), {
    target: { value: "年假规则" },
  });
  fireEvent.click(screen.getByRole("button", { name: "发送" }));
  await waitFor(() =>
    expect(fetchMock.mock.calls.filter(([, init]) => init?.method === "POST")).toHaveLength(1),
  );
}
describe("已有会话单轮助手选择", () => {
  it("选择后两轮都发送 preferred directive，成功后保留选择，不写会话设置", async () => {
    render(<ThreadInput {...props} />);
    await chooseAgent();
    await send();
    await waitFor(() =>
      expect(
        (screen.getByRole("textbox", { name: "消息输入框" }) as HTMLTextAreaElement).value,
      ).toBe(""),
    );
    expect(screen.getByRole("button", { name: "人力助手" })).toBeTruthy();
    const post = fetchMock.mock.calls.find(([, init]) => init?.method === "POST")!;
    expect(JSON.parse(post[1]!.body as string)).toEqual({
      input: { type: "message", text: "年假规则" },
      agent_use: { mode: "preferred", agent_id: "hr-agent" },
    });
    expect(fetchMock.mock.calls.some(([, init]) => init?.method === "PATCH")).toBe(false);
    fetchMock.mockClear();
    await send();
    const second = fetchMock.mock.calls.find(([, init]) => init?.method === "POST")!;
    expect(JSON.parse(second[1]!.body as string).agent_use).toEqual({
      mode: "preferred",
      agent_id: "hr-agent",
    });
  });
  it("首条消息后或刷新时从已保存的本轮选择复显，主动清空优先于旧选择", async () => {
    const latestTurn = {
      id: "turn-1",
      turn_state: "completed",
      agent_use: { mode: "preferred", agent_id: "hr-agent", display_name: "人力助手" },
    } as ClientTurn;
    render(<ThreadInput {...props} latestTurn={latestTurn} />);
    fireEvent.click(screen.getByRole("button", { name: "人力助手" }));
    fireEvent.click(await screen.findByRole("button", { name: "不指定助手" }));
    await send();
    const post = fetchMock.mock.calls.find(([, init]) => init?.method === "POST")!;
    expect(JSON.parse(post[1]!.body as string)).not.toHaveProperty("agent_use");
  });
  it("发送失败保留选择和草稿，可显式取消选择", async () => {
    rejectSend = true;
    render(<ThreadInput {...props} />);
    await chooseAgent();
    await send();
    await screen.findByRole("alert");
    expect((screen.getByRole("textbox", { name: "消息输入框" }) as HTMLTextAreaElement).value).toBe(
      "年假规则",
    );
    fireEvent.click(screen.getByRole("button", { name: "人力助手" }));
    fireEvent.click(await screen.findByRole("button", { name: "不指定助手" }));
    expect(screen.getByRole("button", { name: "优先助手" })).toBeTruthy();
  });
  it("切换会话不会继承未发送的助手选择", async () => {
    const { rerender } = render(<ThreadInput {...props} />);
    await chooseAgent();
    rerender(<ThreadInput {...props} threadId="thread-2" />);
    expect(screen.getByRole("button", { name: "优先助手" })).toBeTruthy();
    rerender(<ThreadInput {...props} />);
    expect(screen.getByRole("button", { name: "优先助手" })).toBeTruthy();
  });
  it.each(["running", "waiting_user"] as const)(
    "%s 时不可重选当前任务的助手且无 Stop",
    async (turnState) => {
      await act(async () => {
        render(
          <ThreadInput
            {...props}
            latestTurn={
              {
                id: "turn-1",
                turn_state: turnState,
                controls: { cancel_supported: false },
              } as ClientTurn
            }
          />,
        );
      });
      expect((screen.getByRole("button", { name: "优先助手" }) as HTMLButtonElement).disabled).toBe(
        true,
      );
      expect(screen.queryByRole("button", { name: "停止任务" })).toBeNull();
    },
  );
});
