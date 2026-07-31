/**
 * S10-W04：CatalogSelect 组件测试。
 *
 * 覆盖：
 * - 挂载时拉取目录并渲染选项。
 * - loading 时 select disabled。
 * - 错误时显示错误提示。
 * - 选中值变化触发 onChange。
 * - lifecycle_state != enabled 的选项 disabled。
 * - excludeIds 排除特定 resource_id。
 */
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const fetchMock = vi.fn();
vi.stubGlobal("fetch", fetchMock);

import { CatalogSelect } from "./catalog-select";

afterEach(() => {
  cleanup();
  fetchMock.mockReset();
});

beforeEach(() => {
  fetchMock.mockReset();
});

function buildCatalogResponse(items: unknown[]) {
  return new Response(JSON.stringify({ items, next_cursor: null, catalog_revision: 1 }), {
    status: 200,
    headers: { etag: '"catalog-tenant-employee-1"' },
  });
}

describe("CatalogSelect", () => {
  it("挂载时拉取并渲染选项", async () => {
    fetchMock.mockResolvedValueOnce(
      buildCatalogResponse([
        {
          resource_type: "agent",
          resource_id: "agent-001",
          display_name: "通用 Agent",
          description: null,
          lifecycle_state: "enabled",
          visibility_summary: "",
          owner_user_id: null,
          tags: null,
          etag: "catalog-1",
        },
        {
          resource_type: "agent",
          resource_id: "agent-002",
          display_name: "专用 Agent",
          description: null,
          lifecycle_state: "enabled",
          visibility_summary: "",
          owner_user_id: null,
          tags: null,
          etag: "catalog-1",
        },
      ]),
    );

    const onChange = vi.fn();
    render(
      <CatalogSelect resourceType="agent" value="agent-001" onChange={onChange} label="主 Agent" />,
    );

    await waitFor(() => {
      expect(screen.getByLabelText("主 Agent")).not.toBeNull();
    });

    const select = screen.getByLabelText("主 Agent") as HTMLSelectElement;
    expect(select.value).toBe("agent-001");
    // 2 个 agent 选项
    expect(select.options.length).toBe(2);
  });

  it("loading 时 select disabled", () => {
    fetchMock.mockReturnValueOnce(new Promise(() => {})); // 永不 resolve

    render(
      <CatalogSelect resourceType="agent" value={null} onChange={() => {}} label="主 Agent" />,
    );

    const select = screen.getByLabelText("主 Agent") as HTMLSelectElement;
    expect(select.disabled).toBe(true);
  });

  it("错误时显示错误提示", async () => {
    fetchMock.mockResolvedValueOnce(
      new Response(
        JSON.stringify({
          error: {
            code: "AUTHENTICATION_REQUIRED",
            message: "未登录",
            request_id: "r1",
            retryable: false,
          },
        }),
        { status: 401 },
      ),
    );

    render(
      <CatalogSelect resourceType="agent" value={null} onChange={() => {}} label="主 Agent" />,
    );

    await waitFor(() => {
      expect(screen.getByRole("alert")).not.toBeNull();
    });
    expect(screen.getByText(/目录加载失败/)).not.toBeNull();
  });

  it("选中值变化触发 onChange", async () => {
    fetchMock.mockResolvedValueOnce(
      buildCatalogResponse([
        {
          resource_type: "agent",
          resource_id: "agent-001",
          display_name: "Agent A",
          description: null,
          lifecycle_state: "enabled",
          visibility_summary: "",
          owner_user_id: null,
          tags: null,
          etag: "catalog-1",
        },
      ]),
    );

    const onChange = vi.fn();
    render(
      <CatalogSelect resourceType="agent" value="agent-001" onChange={onChange} label="主 Agent" />,
    );

    await waitFor(() => {
      expect((screen.getByLabelText("主 Agent") as HTMLSelectElement).options.length).toBe(1);
    });

    fireEvent.change(screen.getByLabelText("主 Agent"), {
      target: { value: "agent-001" },
    });
    expect(onChange).toHaveBeenCalledWith("agent-001");
  });

  it("lifecycle_state != enabled 的选项 disabled", async () => {
    fetchMock.mockResolvedValueOnce(
      buildCatalogResponse([
        {
          resource_type: "agent",
          resource_id: "agent-001",
          display_name: "启用 Agent",
          description: null,
          lifecycle_state: "enabled",
          visibility_summary: "",
          owner_user_id: null,
          tags: null,
          etag: "catalog-1",
        },
        {
          resource_type: "agent",
          resource_id: "agent-002",
          display_name: "禁用 Agent",
          description: null,
          lifecycle_state: "disabled",
          visibility_summary: "",
          owner_user_id: null,
          tags: null,
          etag: "catalog-1",
        },
      ]),
    );

    render(
      <CatalogSelect resourceType="agent" value="agent-001" onChange={() => {}} label="主 Agent" />,
    );

    await waitFor(() => {
      const select = screen.getByLabelText("主 Agent") as HTMLSelectElement;
      expect(select.options.length).toBe(2);
      expect(select.options[1]?.disabled).toBe(true); // 禁用 Agent
    });
  });

  it("excludeIds 排除特定 resource_id", async () => {
    fetchMock.mockResolvedValueOnce(
      buildCatalogResponse([
        {
          resource_type: "agent",
          resource_id: "agent-001",
          display_name: "Agent A",
          description: null,
          lifecycle_state: "enabled",
          visibility_summary: "",
          owner_user_id: null,
          tags: null,
          etag: "catalog-1",
        },
        {
          resource_type: "agent",
          resource_id: "agent-002",
          display_name: "Agent B",
          description: null,
          lifecycle_state: "enabled",
          visibility_summary: "",
          owner_user_id: null,
          tags: null,
          etag: "catalog-1",
        },
      ]),
    );

    render(
      <CatalogSelect
        resourceType="agent"
        value={null}
        onChange={() => {}}
        label="主 Agent"
        excludeIds={["agent-001"]}
      />,
    );

    await waitFor(() => {
      const select = screen.getByLabelText("主 Agent") as HTMLSelectElement;
      // placeholder（value="") + agent-002 = 2 个 option；agent-001 被排除
      expect(select.options.length).toBe(2);
      expect(select.options[0]?.value).toBe("");
      expect(select.options[1]?.value).toBe("agent-002");
    });
  });

  it("allowClear=true 时添加（无）选项", async () => {
    fetchMock.mockResolvedValueOnce(buildCatalogResponse([]));

    render(
      <CatalogSelect
        resourceType="agent"
        value={null}
        onChange={() => {}}
        label="主 Agent"
        allowClear
      />,
    );

    await waitFor(() => {
      const select = screen.getByLabelText("主 Agent") as HTMLSelectElement;
      // 第一个选项为 "（无）"
      expect(select.options[0]?.value).toBe("");
      expect(select.options[0]?.textContent).toContain("（无）");
    });
  });
});
