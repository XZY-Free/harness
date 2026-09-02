import { AgentContractPanel } from "@/components/studio/agent-contract-panel";
import type { AgentContractSnapshotDTO } from "@/lib/control-plane-client";
import { cleanup, render, screen, waitFor } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";

afterEach(cleanup);

function snapshotFixture(): AgentContractSnapshotDTO {
  return {
    snapshot_id: "snap-0001-full",
    contract_version: "1.0.0",
    public_agent_version: "1.0.0",
    protocol_type: "a2a",
    protocol_contract_revision: "a2a@1",
    contract_digest: `sha256:${"a".repeat(64)}`,
    capability_digest: `sha256:${"b".repeat(64)}`,
    context_digest: `sha256:${"c".repeat(64)}`,
    interaction: {
      streaming_transport: true,
      incremental_content: false,
      input_required: true,
      resume: true,
      cancel: false,
      durable_task_recovery: false,
      supported_locales: ["zh-CN"],
    },
    capabilities: [
      {
        key: "leave_task",
        name: { "zh-CN": "假勤休假", en: null },
        description: { "zh-CN": "年假/调休查询与申请", en: null },
        tags: ["hr"],
        examples: ["我今年还有多少年假？"],
        input_modes: ["text"],
        output_modes: ["text"],
      },
    ],
    invocation_context: [
      {
        key: "execution_subject",
        name: { "zh-CN": "执行主体", en: null },
        description: { "zh-CN": null, en: null },
        necessity: "required",
        applies_to: null,
        trust_requirement: null,
        declaration_source: "provider_declared",
      },
      {
        key: "timezone",
        name: { "zh-CN": "时区", en: null },
        description: { "zh-CN": null, en: null },
        necessity: "preferred",
        applies_to: null,
        trust_requirement: null,
        declaration_source: "operator_declared",
      },
    ],
    result_contract: {
      fields: ["status", "answer"],
      error_codes: ["failed"],
      notes: { "zh-CN": null, en: null },
    },
    captured_at: "2026-08-25T00:00:00.000Z",
  };
}

describe("AgentContractPanel（09 §4/§5）", () => {
  it("展示 Capability Manifest（能力名称/描述/标签/示例，非函数列表）", async () => {
    const loadContracts = vi.fn().mockResolvedValue({ items: [snapshotFixture()] });
    render(<AgentContractPanel agentId="agent-1" loadContracts={loadContracts} />);

    await waitFor(() => {
      expect(screen.getByText("假勤休假")).toBeTruthy();
    });
    expect(screen.getByText(/年假\/调休查询与申请/)).toBeTruthy();
    expect(screen.getByText(/#hr/)).toBeTruthy();
    expect(screen.getByText(/我今年还有多少年假？/)).toBeTruthy();
    expect(loadContracts).toHaveBeenCalledWith("agent-1");
  });

  it("三组 Context Contract + operator_declared 标『管理员登记』", async () => {
    const loadContracts = vi.fn().mockResolvedValue({ items: [snapshotFixture()] });
    render(<AgentContractPanel agentId="agent-1" loadContracts={loadContracts} />);

    await waitFor(() => {
      expect(screen.getByText("执行主体")).toBeTruthy();
    });
    expect(screen.getAllByText(/智能体声明/).length).toBeGreaterThanOrEqual(1);
    expect(screen.getAllByText("管理员登记").length).toBeGreaterThanOrEqual(1);
    expect(screen.getAllByText("时区").length).toBeGreaterThanOrEqual(1);
  });

  it("展示 Snapshot id、Agent version、三个 digest 与 interaction 六布尔（07 §5）", async () => {
    const loadContracts = vi.fn().mockResolvedValue({ items: [snapshotFixture()] });
    render(<AgentContractPanel agentId="agent-1" loadContracts={loadContracts} />);

    await waitFor(() => {
      expect(screen.getAllByText(/snap-0001-full/).length).toBeGreaterThanOrEqual(1);
    });
    const technicalDetails = screen.getByText("查看技术信息").closest("details");
    expect(technicalDetails?.open).toBe(false);
    expect(screen.getAllByText(/能力摘要/).length).toBeGreaterThanOrEqual(1);
    expect(screen.getAllByText(/上下文摘要/).length).toBeGreaterThanOrEqual(1);
    expect(screen.getAllByText(`sha256:${"b".repeat(64)}`).length).toBeGreaterThanOrEqual(1);
    expect(screen.getAllByText(`sha256:${"c".repeat(64)}`).length).toBeGreaterThanOrEqual(1);
    // 六布尔以可访问文本表达，避免用文本符号冒充图标。
    expect(screen.getAllByLabelText("流式传输：支持")[0]?.textContent).toContain("支持");
    expect(screen.getAllByLabelText("增量内容：不支持")[0]?.textContent).toContain("不支持");
    expect(screen.getAllByLabelText("恢复任务：支持")[0]?.textContent).toContain("支持");
    expect(screen.getAllByLabelText("取消任务：不支持")[0]?.textContent).toContain("不支持");
    expect(document.body.textContent).not.toContain("interaction_");
  });

  it("加载与失败状态可被辅助技术及时感知", async () => {
    let rejectLoad: ((reason: Error) => void) | undefined;
    const loadContracts = vi.fn(
      () =>
        new Promise<{ items: AgentContractSnapshotDTO[] }>((_resolve, reject) => {
          rejectLoad = reject;
        }),
    );
    render(<AgentContractPanel agentId="agent-1" loadContracts={loadContracts} />);

    expect(screen.getByRole("status").textContent).toContain("合同加载中");
    rejectLoad?.(new Error("failed"));
    await waitFor(() => expect(screen.getByRole("alert")).toBeTruthy());
    expect(screen.getByRole("alert").textContent).toContain("合同加载失败");
  });

  it("无 Snapshot 时显示空态（Agent 未登记外部合同）", async () => {
    const loadContracts = vi.fn().mockResolvedValue({ items: [] });
    render(<AgentContractPanel agentId="agent-1" loadContracts={loadContracts} />);

    await waitFor(() => {
      expect(screen.getByText("暂无外部合同")).toBeTruthy();
    });
  });
});
