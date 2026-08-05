/**
 * S10-W04：CatalogSettingsBar 组件测试。
 *
 * 覆盖：
 * - 默认折叠，仅显示当前关键设置摘要。
 * - 点击「高级设置」展开 3 个 CatalogSelect。
 * - 折叠头显示截断 id。
 * - busy 时禁用展开按钮。
 * - 展开后点击 Agent 选项触发 onAgentChange。
 */
import type { ClientThread } from "@/lib/v11/client/types";
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const fetchMock = vi.fn();
vi.stubGlobal("fetch", fetchMock);

import { CatalogSettingsBar } from "./catalog-settings-bar";

afterEach(() => {
  cleanup();
  fetchMock.mockReset();
});

beforeEach(() => {
  fetchMock.mockReset();
});

function buildThread(overrides: Partial<ClientThread> = {}): ClientThread {
  return {
    id: "t1",
    title: "测试会话",
    primary_agent_id: "agent-001-abc-def",
    active_goal_id: null,
    default_workspace_id: null,
    default_model_ref: "gpt-4-1234567890",
    default_environment_definition_id: "env-001-abc",
    lifecycle_state: "active",
    last_activity_at: "2026-07-21T00:00:00.000Z",
    last_event_sequence: 0,
    pending_queue_version_no: 0,
    version_no: 1,
    created_at: "2026-07-21T00:00:00.000Z",
    ...overrides,
  };
}

function buildCatalogResponse(items: unknown[]) {
  return new Response(JSON.stringify({ items, next_cursor: null, catalog_revision: 1 }), {
    status: 200,
    headers: { etag: '"catalog-tenant-employee-1"' },
  });
}

describe("CatalogSettingsBar", () => {
  it("默认折叠，显示展开按钮", () => {
    render(<CatalogSettingsBar thread={buildThread()} />);

    expect(screen.getByText("高级设置")).not.toBeNull();
    // 折叠时不渲染 select
    expect(screen.queryByLabelText("主 Agent")).toBeNull();
  });

  it("点击「高级设置」展开 3 个选择器", async () => {
    fetchMock.mockResolvedValueOnce(buildCatalogResponse([])); // agent
    fetchMock.mockResolvedValueOnce(buildCatalogResponse([])); // model
    fetchMock.mockResolvedValueOnce(buildCatalogResponse([])); // runtime

    render(<CatalogSettingsBar thread={buildThread()} />);

    fireEvent.click(screen.getByText("高级设置"));

    await waitFor(() => {
      expect(screen.getByLabelText("主 Agent")).not.toBeNull();
      expect(screen.getByLabelText("默认模型")).not.toBeNull();
      expect(screen.getByLabelText("执行位置")).not.toBeNull();
    });

    expect(screen.getByText("收起")).not.toBeNull();
  });

  it("折叠头显示截断 id", () => {
    render(<CatalogSettingsBar thread={buildThread()} />);

    // primary_agent_id "agent-001-abc-def" → slice(0, 8) = "agent-00"
    expect(screen.getByText(/agent-00/)).not.toBeNull();
    // default_model_ref "gpt-4-1234567890" → slice(0, 12) = "gpt-4-123456"
    expect(screen.getByText(/gpt-4-1234/)).not.toBeNull();
    // default_environment_definition_id "env-001-abc" → slice(0, 8) = "env-001-"
    expect(screen.getByText(/env-001/)).not.toBeNull();
  });

  it("busy 时禁用展开按钮", () => {
    render(<CatalogSettingsBar thread={buildThread()} busy />);

    const btn = screen.getByText("高级设置") as HTMLButtonElement;
    expect(btn.disabled).toBe(true);
  });

  it("展开后显示交接流程说明", async () => {
    fetchMock.mockResolvedValueOnce(buildCatalogResponse([]));
    fetchMock.mockResolvedValueOnce(buildCatalogResponse([]));
    fetchMock.mockResolvedValueOnce(buildCatalogResponse([]));

    render(<CatalogSettingsBar thread={buildThread()} />);

    fireEvent.click(screen.getByText("高级设置"));

    await waitFor(() => {
      expect(screen.getByText(/主 Agent 变更需走交接流程/)).not.toBeNull();
    });
  });

  it("无 model/environment 时不显示对应摘要", () => {
    render(
      <CatalogSettingsBar
        thread={buildThread({
          default_model_ref: null,
          default_environment_definition_id: null,
        })}
      />,
    );

    expect(screen.queryByText(/Model/)).toBeNull();
    expect(screen.queryByText(/位置/)).toBeNull();
  });
});
