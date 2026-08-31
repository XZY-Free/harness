/**
 * S11-W01 nav-visibility 单元测试。
 *
 * 覆盖：
 * - dev 模式 + DEFAULT_USER_ID → 全部可见
 * - dev 模式 + 非 DEFAULT_USER_ID → 按 binding 计算
 * - 无任何 binding → 全部隐藏（fail-closed）
 * - 部分绑定 → 任意匹配的菜单可见
 * - 查询异常 → 全部隐藏（fail-closed）
 * - NAV_ACTION_MAPPING 完整性：8 个 navId 全部覆盖
 */
import { authConfig } from "@/lib/config";
import { DEFAULT_USER_ID } from "@/lib/constants";
import type { Principal } from "@/lib/identity/resolver";
import type { RoleActionBinding } from "@/lib/persistence/schema/authorization";
import {
  NAV_ACTION_MAPPING,
  STUDIO_NAV_IDS,
  computeStudioNavVisibility,
} from "@/lib/studio/nav-visibility";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

// Mock listActiveActionBindingsForUser（避免触发 DB）
vi.mock("@/lib/identity/role-action-queries", () => ({
  listActiveActionBindingsForUser: vi.fn(),
}));

// Mock authConfig（可动态切换 mode）
vi.mock("@/lib/config", () => ({
  authConfig: { mode: "trusted-headers" },
}));

const { listActiveActionBindingsForUser } = await import("@/lib/identity/role-action-queries");

function makePrincipal(externalSubject = DEFAULT_USER_ID): Principal {
  return {
    tenantId: "tenant-test",
    tenantKey: "test",
    userIdentityId: "identity-test",
    externalSubject,
    email: "test@example.com",
    displayName: "Test",
    audience: "admin",
  };
}

function makeBinding(actionCode: string): RoleActionBinding {
  return {
    id: `binding-${actionCode}`,
    tenantId: "tenant-test",
    principalBindingId: "pb-test",
    actionCode,
    resourceScopeJson: JSON.stringify({ type: "tenant", ids: ["*"] }),
    validFrom: new Date(),
    validUntil: null,
    createdAt: new Date(),
  } as unknown as RoleActionBinding;
}

describe("computeStudioNavVisibility", () => {
  beforeEach(() => {
    vi.mocked(listActiveActionBindingsForUser).mockReset();
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("dev 模式 + DEFAULT_USER_ID → 全部可见", async () => {
    (authConfig as { mode: string }).mode = "dev";
    vi.mocked(listActiveActionBindingsForUser).mockResolvedValue([]);

    const visibility = await computeStudioNavVisibility(makePrincipal());

    expect(visibility.agents).toBe(true);
    expect(visibility.capabilities).toBe(true);
    expect(visibility.conversations).toBe(true);
    expect(visibility.runtime).toBe(true);
    expect(visibility.observability).toBe(true);
    expect(visibility.security).toBe(true);
    expect(visibility.operations).toBe(true);
    expect(visibility.settings).toBe(true);

    // dev 模式应跳过 DB 查询
    expect(listActiveActionBindingsForUser).not.toHaveBeenCalled();
  });

  it("trusted-headers 模式 + 无 binding → 全部隐藏", async () => {
    (authConfig as { mode: string }).mode = "trusted-headers";
    vi.mocked(listActiveActionBindingsForUser).mockResolvedValue([]);

    const visibility = await computeStudioNavVisibility(makePrincipal("non-default-user"));

    expect(visibility.agents).toBe(false);
    expect(visibility.capabilities).toBe(false);
    expect(visibility.conversations).toBe(false);
    expect(visibility.runtime).toBe(false);
    expect(visibility.observability).toBe(false);
    expect(visibility.security).toBe(false);
    expect(visibility.operations).toBe(false);
    expect(visibility.settings).toBe(false);
  });

  it("trusted-headers 模式 + agent.publish 绑定 → agents 菜单可见", async () => {
    (authConfig as { mode: string }).mode = "trusted-headers";
    vi.mocked(listActiveActionBindingsForUser).mockResolvedValue([makeBinding("agent.publish")]);

    const visibility = await computeStudioNavVisibility(makePrincipal("non-default-user"));

    expect(visibility.agents).toBe(true);
    expect(visibility.capabilities).toBe(false);
    expect(visibility.conversations).toBe(false);
    expect(visibility.runtime).toBe(false);
    expect(visibility.observability).toBe(false);
    expect(visibility.security).toBe(false);
    expect(visibility.operations).toBe(false);
    expect(visibility.settings).toBe(false);
  });

  it("trusted-headers 模式 + 多 action 绑定 → 任意匹配的菜单可见", async () => {
    (authConfig as { mode: string }).mode = "trusted-headers";
    vi.mocked(listActiveActionBindingsForUser).mockResolvedValue([
      makeBinding("skill.create"),
      makeBinding("tool.create"),
      makeBinding("audit.export"),
      makeBinding("user.manage"),
    ]);

    const visibility = await computeStudioNavVisibility(makePrincipal("non-default-user"));

    // capabilities: skill.create 或 tool.create → true
    expect(visibility.capabilities).toBe(true);
    // operations: audit.export → true
    expect(visibility.operations).toBe(true);
    // security: policy.publish 或 audit.export → true
    expect(visibility.security).toBe(true);
    // settings: user.manage → true（与设置页真实门禁一致）
    expect(visibility.settings).toBe(true);
    // 其他无绑定
    expect(visibility.agents).toBe(false);
    expect(visibility.conversations).toBe(false);
    expect(visibility.runtime).toBe(false);
    expect(visibility.observability).toBe(false);
  });

  it("平台设置只随 user.manage 显示，不因 policy.publish 误显示", async () => {
    (authConfig as { mode: string }).mode = "trusted-headers";
    vi.mocked(listActiveActionBindingsForUser).mockResolvedValue([makeBinding("policy.publish")]);
    expect((await computeStudioNavVisibility(makePrincipal("non-default-user"))).settings).toBe(
      false,
    );

    vi.mocked(listActiveActionBindingsForUser).mockResolvedValue([makeBinding("user.manage")]);
    expect((await computeStudioNavVisibility(makePrincipal("non-default-user"))).settings).toBe(
      true,
    );
  });

  it("查询异常 → 全部隐藏（fail-closed）", async () => {
    (authConfig as { mode: string }).mode = "trusted-headers";
    vi.mocked(listActiveActionBindingsForUser).mockRejectedValue(new Error("DB down"));

    const visibility = await computeStudioNavVisibility(makePrincipal("non-default-user"));

    expect(visibility.agents).toBe(false);
    expect(visibility.capabilities).toBe(false);
    expect(visibility.conversations).toBe(false);
    expect(visibility.runtime).toBe(false);
    expect(visibility.observability).toBe(false);
    expect(visibility.security).toBe(false);
    expect(visibility.operations).toBe(false);
    expect(visibility.settings).toBe(false);
  });
});

describe("NAV_ACTION_MAPPING 完整性", () => {
  it("8 个 navId 全部有 action 映射", () => {
    for (const navId of STUDIO_NAV_IDS) {
      const actions = NAV_ACTION_MAPPING[navId];
      expect(actions, `navId ${navId} 应有 action 映射`).toBeDefined();
      expect(actions.length, `navId ${navId} 应至少有一个 action`).toBeGreaterThan(0);
    }
  });

  it("8 个 navId 全部覆盖 StudioNavVisibility 字段", () => {
    // STUDIO_NAV_IDS 应包含所有 8 个 navId
    expect(STUDIO_NAV_IDS.length).toBe(8);
    expect(STUDIO_NAV_IDS).toContain("agents");
    expect(STUDIO_NAV_IDS).toContain("capabilities");
    expect(STUDIO_NAV_IDS).toContain("conversations");
    expect(STUDIO_NAV_IDS).toContain("runtime");
    expect(STUDIO_NAV_IDS).toContain("observability");
    expect(STUDIO_NAV_IDS).toContain("security");
    expect(STUDIO_NAV_IDS).toContain("operations");
    expect(STUDIO_NAV_IDS).toContain("settings");
  });
});
