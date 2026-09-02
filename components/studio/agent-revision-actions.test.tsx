import { AgentRevisionActions } from "@/components/studio/agent-revision-actions";
import type { AgentContractSnapshotDTO } from "@/lib/control-plane-client";
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const fetchMock = vi.fn();
vi.stubGlobal("fetch", fetchMock);

function snapshot(id: string): AgentContractSnapshotDTO {
  return {
    snapshot_id: id,
    contract_version: "1.0.0",
    public_agent_version: "1.0.0",
    protocol_type: "a2a",
    protocol_contract_revision: "a2a@0.3.0",
    contract_digest: `sha256:${id}`,
    capability_digest: `sha256:${id}`,
    context_digest: `sha256:${id}`,
    interaction: {
      streaming_transport: true,
      incremental_content: false,
      input_required: false,
      resume: false,
      cancel: false,
      durable_task_recovery: false,
      supported_locales: ["zh-CN"],
    },
    capabilities: [],
    invocation_context: [],
    result_contract: { fields: [], error_codes: [], notes: { "zh-CN": null, en: null } },
    captured_at: "2026-08-26T00:00:00.000Z",
  };
}

function draftRevision() {
  return {
    id: "arev-1",
    agent_id: "agent-1",
    revision_no: 1,
    revision_state: "draft" as const,
    agent_contract_snapshot_id: "snap-0001",
    etag: "agent-revision-1",
  };
}

function publishedRevision() {
  return {
    ...draftRevision(),
    revision_state: "published" as const,
  };
}

function stubBackend(contracts: AgentContractSnapshotDTO[]) {
  fetchMock.mockImplementation(async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = String(input);
    const method = init?.method ?? "GET";
    if (url === "/admin/api/v1/agents/agent-1/contracts") {
      return Response.json({ items: contracts, total: contracts.length });
    }
    if (url === "/admin/api/v1/agents/agent-1/revisions" && method === "POST") {
      return Response.json(draftRevision());
    }
    if (url === "/admin/api/v1/agents/agent-1/revisions") {
      return Response.json({ items: [draftRevision()], total: 1 });
    }
    if (url === "/admin/api/v1/agent-revisions/arev-1/publish" && method === "POST") {
      return Response.json({
        id: "arev-1",
        revision_state: "published",
        published_at: "2026-08-27T00:00:00.000Z",
        audit_event_id: "audit-arev-1",
      });
    }
    return Response.json({ items: [], total: 0 });
  });
}

beforeEach(() => {
  fetchMock.mockReset();
});

afterEach(cleanup);

function selectedSnapshot(): string {
  return screen.getByLabelText("创建版本使用的合同").getAttribute("data-selected-id") ?? "";
}

async function chooseSnapshot(record: number) {
  fireEvent.click(screen.getByLabelText("创建版本使用的合同"));
  const option = await screen.findByRole("option", { name: new RegExp(`记录 ${record}$`) });
  fireEvent.pointerDown(option, { pointerType: "mouse" });
  fireEvent.click(option);
}

describe("AgentRevisionActions（刷新时选择保留/清空）", () => {
  it("reload 后保留仍在真实列表中的人工选择，不被旧 handoff 抢回", async () => {
    stubBackend([snapshot("snap-0001"), snapshot("snap-0002")]);

    const view = render(
      <AgentRevisionActions agentId="agent-1" preferredSnapshotId="snap-0001" refreshToken={0} />,
    );
    await waitFor(() => expect(selectedSnapshot()).toBe("snap-0001"));

    // 人工改选另一个真实合同。
    await chooseSnapshot(2);
    expect(selectedSnapshot()).toBe("snap-0002");

    // 刷新代次变化触发 reload：人工选择仍有效，不得回退到 preferred。
    view.rerender(
      <AgentRevisionActions agentId="agent-1" preferredSnapshotId="snap-0001" refreshToken={1} />,
    );
    await waitFor(() => expect(selectedSnapshot()).toBe("snap-0002"));
  });

  it("当前选择已不在真实列表且无 preferred 时清空，不保留失效值", async () => {
    stubBackend([snapshot("snap-0001"), snapshot("snap-0002")]);

    const view = render(<AgentRevisionActions agentId="agent-1" refreshToken={0} />);
    await waitFor(() => expect(selectedSnapshot()).toBe(""));

    await chooseSnapshot(2);
    expect(selectedSnapshot()).toBe("snap-0002");

    // 刷新后 snap-0002 已被删除、preferred 为空：清空选择。
    stubBackend([snapshot("snap-0001")]);
    view.rerender(<AgentRevisionActions agentId="agent-1" refreshToken={1} />);
    await waitFor(() => expect(selectedSnapshot()).toBe(""));
  });
});

describe("AgentRevisionActions（发布成功交接 onPublished）", () => {
  it("真实 publish API 成功返回后，用返回响应对象调用 onPublished 恰好一次（携带返回 id）", async () => {
    stubBackend([snapshot("snap-0001")]);
    const onPublished = vi.fn();

    render(<AgentRevisionActions agentId="agent-1" onPublished={onPublished} />);

    const publishButton = await screen.findByRole("button", { name: "发布" });
    fireEvent.click(publishButton);

    await waitFor(() =>
      expect(
        fetchMock.mock.calls.some(
          ([url, init]) =>
            String(url) === "/admin/api/v1/agent-revisions/arev-1/publish" &&
            init?.method === "POST",
        ),
      ).toBe(true),
    );

    // 只由真实 publish 响应触发，恰好一次，携带后端返回的 id。
    await waitFor(() => expect(onPublished).toHaveBeenCalledTimes(1));
    expect(onPublished).toHaveBeenCalledWith(
      expect.objectContaining({ id: "arev-1", revision_state: "published" }),
    );
  });

  it("发布请求保留幂等键与版本匹配头，成功反馈使用可访问状态", async () => {
    stubBackend([snapshot("snap-0001")]);
    render(<AgentRevisionActions agentId="agent-1" />);

    fireEvent.click(await screen.findByRole("button", { name: "发布" }));

    await waitFor(() => expect(screen.getByRole("status").textContent).toContain("版本 1 已发布"));
    const call = fetchMock.mock.calls.find(
      ([url, init]) =>
        String(url) === "/admin/api/v1/agent-revisions/arev-1/publish" && init?.method === "POST",
    );
    expect(call).toBeTruthy();
    const headers = new Headers(call?.[1]?.headers);
    expect(headers.get("Idempotency-Key")).toBeTruthy();
    expect(headers.get("If-Match")).toBe("agent-revision-1");
  });

  it("四个策略字段只接受 JSON 对象，错误反馈使用中文且不会发出创建请求", async () => {
    stubBackend([snapshot("snap-0001")]);
    render(<AgentRevisionActions agentId="agent-1" preferredSnapshotId="snap-0001" />);

    await waitFor(() =>
      expect(
        (screen.getByRole("button", { name: "创建草稿版本" }) as HTMLButtonElement).disabled,
      ).toBe(false),
    );
    fireEvent.change(screen.getByLabelText("模型策略"), { target: { value: "[]" } });
    fireEvent.click(screen.getByRole("button", { name: "创建草稿版本" }));

    expect(screen.getByRole("alert").textContent).toContain("模型策略必须是 JSON 对象");
    expect(
      fetchMock.mock.calls.some(
        ([url, init]) =>
          String(url) === "/admin/api/v1/agents/agent-1/revisions" && init?.method === "POST",
      ),
    ).toBe(false);
  });

  it("创建草稿版本不得触发 onPublished", async () => {
    stubBackend([snapshot("snap-0001")]);
    const onPublished = vi.fn();

    render(
      <AgentRevisionActions
        agentId="agent-1"
        preferredSnapshotId="snap-0001"
        onPublished={onPublished}
      />,
    );

    const createButton = await screen.findByRole("button", { name: "创建草稿版本" });
    await waitFor(() => expect((createButton as HTMLButtonElement).disabled).toBe(false));
    fireEvent.click(createButton);

    await waitFor(() => expect(screen.getByText(/已创建草稿版本/)).toBeTruthy());
    // create POST 确已发出（真实 create API），但不得触发发布交接回调。
    await waitFor(() =>
      expect(
        fetchMock.mock.calls.some(
          ([url, init]) =>
            String(url) === "/admin/api/v1/agents/agent-1/revisions" && init?.method === "POST",
        ),
      ).toBe(true),
    );
    expect(onPublished).not.toHaveBeenCalled();
  });

  it("publish 失败时不调用 onPublished", async () => {
    fetchMock.mockImplementation(async (input: RequestInfo | URL) => {
      const url = String(input);
      if (url === "/admin/api/v1/agent-revisions/arev-1/publish") {
        return Response.json(
          {
            error: {
              code: "BUSINESS_CONSTRAINT_VIOLATION",
              message: "前置条件未满足",
              request_id: "req-test",
              retryable: false,
            },
          },
          { status: 400 },
        );
      }
      if (url === "/admin/api/v1/agents/agent-1/contracts") {
        return Response.json({ items: [snapshot("snap-0001")], total: 1 });
      }
      if (url === "/admin/api/v1/agents/agent-1/revisions") {
        return Response.json({ items: [draftRevision()], total: 1 });
      }
      return Response.json({ items: [], total: 0 });
    });
    const onPublished = vi.fn();

    render(<AgentRevisionActions agentId="agent-1" onPublished={onPublished} />);

    const publishButton = await screen.findByRole("button", { name: "发布" });
    fireEvent.click(publishButton);

    await waitFor(() => expect(screen.getByText(/业务约束拒绝/)).toBeTruthy());
    expect(onPublished).not.toHaveBeenCalled();
  });

  it("撤回已发布智能体版本必须明确二次确认，确认前零写请求", async () => {
    fetchMock.mockImplementation(async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = String(input);
      if (url.endsWith("/contracts")) {
        return Response.json({ items: [snapshot("snap-0001")], total: 1 });
      }
      if (url.endsWith("/revisions") && (init?.method ?? "GET") === "GET") {
        return Response.json({ items: [publishedRevision()], total: 1 });
      }
      if (url.endsWith("/withdraw") && init?.method === "POST") {
        return Response.json({ id: "arev-1", revision_state: "withdrawn" });
      }
      return Response.json({ items: [], total: 0 });
    });
    render(<AgentRevisionActions agentId="agent-1" />);

    fireEvent.click(await screen.findByRole("button", { name: "撤回" }));
    expect(screen.getByRole("alertdialog")).toBeTruthy();
    expect(screen.getByText("确认撤回第 1 版？")).toBeTruthy();
    expect(
      fetchMock.mock.calls.filter(
        ([url, init]) => String(url).endsWith("/withdraw") && init?.method === "POST",
      ),
    ).toHaveLength(0);

    fireEvent.click(screen.getByRole("button", { name: "确认撤回" }));
    await waitFor(() =>
      expect(
        fetchMock.mock.calls.filter(
          ([url, init]) => String(url).endsWith("/withdraw") && init?.method === "POST",
        ),
      ).toHaveLength(1),
    );
  });
});
