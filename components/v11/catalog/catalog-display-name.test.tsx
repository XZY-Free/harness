/**
 * S10-W04：CatalogDisplayName 组件测试。
 *
 * 覆盖：
 * - 挂载时拉取目录并显示匹配的 display_name。
 * - loading 时显示截断 id。
 * - 资源不在目录中时显示 "（未知）"。
 * - lifecycle_state != enabled 时附加 "（已禁用）"。
 */
import { cleanup, render, screen, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const fetchMock = vi.fn();
vi.stubGlobal("fetch", fetchMock);

import { CatalogDisplayName } from "./catalog-display-name";

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

describe("CatalogDisplayName", () => {
  it("挂载时显示匹配的 display_name", async () => {
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
      ]),
    );

    render(<CatalogDisplayName resourceId="agent-001" resourceType="agent" />);

    await waitFor(() => {
      expect(screen.getByText("通用 Agent")).not.toBeNull();
    });
  });

  it("loading 时显示截断 id", () => {
    fetchMock.mockReturnValueOnce(new Promise(() => {})); // 永不 resolve

    render(<CatalogDisplayName resourceId="agent-abc123def" resourceType="agent" />);

    expect(screen.getByText("agent-ab")).not.toBeNull();
  });

  it("资源不在目录中时显示（未知）", async () => {
    fetchMock.mockResolvedValueOnce(buildCatalogResponse([]));

    render(<CatalogDisplayName resourceId="agent-unknown" resourceType="agent" />);

    await waitFor(() => {
      expect(screen.getByText(/未知/)).not.toBeNull();
    });
  });

  it("lifecycle_state != enabled 时附加（已禁用）", async () => {
    fetchMock.mockResolvedValueOnce(
      buildCatalogResponse([
        {
          resource_type: "agent",
          resource_id: "agent-001",
          display_name: "旧 Agent",
          description: null,
          lifecycle_state: "disabled",
          visibility_summary: "",
          owner_user_id: null,
          tags: null,
          etag: "catalog-1",
        },
      ]),
    );

    render(<CatalogDisplayName resourceId="agent-001" resourceType="agent" />);

    await waitFor(() => {
      expect(screen.getByText("旧 Agent")).not.toBeNull();
      expect(screen.getByText(/已禁用/)).not.toBeNull();
    });
  });

  it("接受自定义 fallback", () => {
    fetchMock.mockReturnValueOnce(new Promise(() => {}));

    render(<CatalogDisplayName resourceId="agent-001" resourceType="agent" fallback="加载中" />);

    expect(screen.getByText("加载中")).not.toBeNull();
  });
});
