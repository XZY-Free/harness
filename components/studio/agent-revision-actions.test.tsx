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

function stubBackend(contracts: AgentContractSnapshotDTO[]) {
  fetchMock.mockImplementation(async (input: RequestInfo | URL) => {
    const url = String(input);
    if (url === "/admin/api/v1/agents/agent-1/contracts") {
      return Response.json({ items: contracts, total: contracts.length });
    }
    if (url === "/admin/api/v1/agents/agent-1/revisions") {
      return Response.json({ items: [], total: 0 });
    }
    return Response.json({ items: [], total: 0 });
  });
}

beforeEach(() => {
  fetchMock.mockReset();
});

afterEach(cleanup);

describe("AgentRevisionActions（刷新时选择保留/清空）", () => {
  it("reload 后保留仍在真实列表中的人工选择，不被旧 handoff 抢回", async () => {
    stubBackend([snapshot("snap-0001"), snapshot("snap-0002")]);

    const view = render(
      <AgentRevisionActions agentId="agent-1" preferredSnapshotId="snap-0001" refreshToken={0} />,
    );
    const select = () => screen.getByLabelText("创建版本使用的合同") as HTMLSelectElement;
    await waitFor(() => expect(select().value).toBe("snap-0001"));

    // 人工改选另一个真实合同。
    fireEvent.change(select(), { target: { value: "snap-0002" } });
    expect(select().value).toBe("snap-0002");

    // 刷新代次变化触发 reload：人工选择仍有效，不得回退到 preferred。
    view.rerender(
      <AgentRevisionActions agentId="agent-1" preferredSnapshotId="snap-0001" refreshToken={1} />,
    );
    await waitFor(() => expect(select().value).toBe("snap-0002"));
  });

  it("当前选择已不在真实列表且无 preferred 时清空，不保留失效值", async () => {
    stubBackend([snapshot("snap-0001"), snapshot("snap-0002")]);

    const view = render(<AgentRevisionActions agentId="agent-1" refreshToken={0} />);
    const select = () => screen.getByLabelText("创建版本使用的合同") as HTMLSelectElement;
    await waitFor(() => expect(select().value).toBe(""));

    fireEvent.change(select(), { target: { value: "snap-0002" } });
    expect(select().value).toBe("snap-0002");

    // 刷新后 snap-0002 已被删除、preferred 为空：清空选择。
    stubBackend([snapshot("snap-0001")]);
    view.rerender(<AgentRevisionActions agentId="agent-1" refreshToken={1} />);
    await waitFor(() => expect(select().value).toBe(""));
  });
});
