import { AgentsRevisionSection } from "@/components/studio/agent-revision-section";
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const fetchMock = vi.fn();
vi.stubGlobal("fetch", fetchMock);

function agent(id: string, name: string) {
  return {
    id,
    agent_key: id,
    display_name: name,
    description: null,
    lifecycle_state: "draft" as const,
    current_revision_id: null,
    owner_user_id: "user-1",
    visibility_policy_id: null,
    version_no: 1,
    updated_at: null,
  };
}

function stubAgents(items: ReturnType<typeof agent>[]) {
  fetchMock.mockImplementation(async (input: RequestInfo | URL) => {
    if (String(input) === "/admin/api/v1/agents") {
      return Response.json({ items, total: items.length });
    }
    return Response.json({ items: [], total: 0 });
  });
}

beforeEach(() => {
  fetchMock.mockReset();
});

afterEach(cleanup);

describe("AgentsRevisionSection（刷新时选择保留/清空）", () => {
  it("刷新成功后清除旧列表错误并恢复版本选择", async () => {
    let fail = true;
    fetchMock.mockImplementation(async (input: RequestInfo | URL) => {
      if (String(input) === "/admin/api/v1/agents") {
        if (fail) throw new Error("temporary failure");
        return Response.json({ items: [agent("agent-1", "HR 智能体")], total: 1 });
      }
      return Response.json({ items: [], total: 0 });
    });

    const view = render(<AgentsRevisionSection refreshToken={0} />);
    await waitFor(() => expect(screen.getByText("智能体列表加载失败")).toBeTruthy());

    fail = false;
    view.rerender(<AgentsRevisionSection refreshToken={1} />);
    await waitFor(() => expect(screen.getByLabelText("创建版本的智能体")).toBeTruthy());
    expect(screen.queryByText("智能体列表加载失败")).toBeNull();
  });

  it("preferred agent 真实存在时优先交接，人工改选后刷新也不回退", async () => {
    stubAgents([agent("agent-1", "HR 智能体"), agent("agent-2", "客服智能体")]);

    const view = render(<AgentsRevisionSection preferredAgentId="agent-1" refreshToken={0} />);
    const select = () => screen.getByLabelText("创建版本的智能体") as HTMLSelectElement;
    await waitFor(() => expect(select().value).toBe("agent-1"));

    // 人工改选另一个真实智能体。
    fireEvent.change(select(), { target: { value: "agent-2" } });
    expect(select().value).toBe("agent-2");

    // 刷新后 preferred 仍真实存在：优先交接，不保留人工选择。
    view.rerender(<AgentsRevisionSection preferredAgentId="agent-1" refreshToken={1} />);
    await waitFor(() => expect(select().value).toBe("agent-1"));
  });

  it("无 preferred 时保留仍在真实列表中的人工选择，已删除则清空", async () => {
    stubAgents([agent("agent-1", "HR 智能体"), agent("agent-2", "客服智能体")]);

    const view = render(<AgentsRevisionSection refreshToken={0} />);
    const select = () => screen.getByLabelText("创建版本的智能体") as HTMLSelectElement;
    await waitFor(() => expect(select().options.length).toBe(3));

    fireEvent.change(select(), { target: { value: "agent-2" } });

    // 刷新后 agent-2 仍在列表：保留人工选择。
    view.rerender(<AgentsRevisionSection refreshToken={1} />);
    await waitFor(() => expect(select().value).toBe("agent-2"));

    // agent-2 被删除且无 preferred：清空，不保留失效 id。
    stubAgents([agent("agent-1", "HR 智能体")]);
    view.rerender(<AgentsRevisionSection refreshToken={2} />);
    await waitFor(() => expect(select().value).toBe(""));
  });
});
