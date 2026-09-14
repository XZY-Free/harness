/**
 * S11-W01 nav-visibility 单元测试。
 *
 * 覆盖：
 * - 所有环境和身份统一按 binding 计算
 * - 无任何 binding → 全部隐藏（fail-closed）
 * - 部分绑定 → 任意匹配的菜单可见
 * - 查询异常 → 全部隐藏（fail-closed）
 * - NAV_ACTION_MAPPING 完整性：8 个 navId 全部覆盖
 */
import { DEFAULT_USER_ID } from "@/lib/constants";
import type { ActionCode } from "@/lib/identity/action-codes";
import type { PermissionContext } from "@/lib/identity/permission-context";
import type { Principal } from "@/lib/identity/resolver";
import {
  NAV_ACTION_MAPPING,
  STUDIO_NAV_IDS,
  computeStudioNavVisibility,
} from "@/lib/studio/nav-visibility";
import { beforeEach, describe, expect, it, vi } from "vitest";

// 仅隔离数据加载；导航仍使用真实权限求值器，DB 行为由权限集成测试覆盖。
vi.mock("@/lib/identity/permission-context", async (original) => ({
  ...(await original<typeof import("@/lib/identity/permission-context")>()),
  loadPermissionContext: vi.fn(),
}));
const { loadPermissionContext } = await import("@/lib/identity/permission-context");
function resolveBindings(grants: PermissionContext["grants"]) {
  vi.mocked(loadPermissionContext).mockResolvedValue({
    tenantId: "tenant-test",
    userId: "identity-test",
    active: true,
    principalIds: new Set(["pb-test"]),
    grants,
    policies: [],
    agents: [],
    enterprise: null,
    digest: "test",
  });
}
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

function makeBinding(actionCode: ActionCode): PermissionContext["grants"][number] {
  return { actionCode, resourceScope: { type: "tenant", wildcard: true }, source: "测试角色" };
}
describe("computeStudioNavVisibility", () => {
  beforeEach(() => {
    vi.mocked(loadPermissionContext).mockReset();
  });

  it("旧默认用户标识也不能绕过真实权限绑定", async () => {
    resolveBindings([]);

    const visibility = await computeStudioNavVisibility(makePrincipal());

    expect(Object.values(visibility).every((visible) => visible === false)).toBe(true);
    expect(loadPermissionContext).toHaveBeenCalledWith("tenant-test", "identity-test");
  });

  it("无 binding → 全部隐藏", async () => {
    resolveBindings([]);

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

  it("agent.publish 绑定 → agents 菜单可见", async () => {
    resolveBindings([makeBinding("studio.access"), makeBinding("agent.publish")]);

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

  it("多 action 绑定 → 任意匹配的菜单可见", async () => {
    resolveBindings([
      makeBinding("studio.access"),
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
    resolveBindings([makeBinding("studio.access"), makeBinding("policy.publish")]);
    expect((await computeStudioNavVisibility(makePrincipal("non-default-user"))).settings).toBe(
      false,
    );

    resolveBindings([makeBinding("studio.access"), makeBinding("user.manage")]);
    expect((await computeStudioNavVisibility(makePrincipal("non-default-user"))).settings).toBe(
      true,
    );
  });

  it("查询异常 → 全部隐藏（fail-closed）", async () => {
    vi.mocked(loadPermissionContext).mockRejectedValue(new Error("DB down"));

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
