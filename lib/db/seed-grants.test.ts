import { describe, expect, it, vi } from "vitest";

// seed 与 nav-visibility 都会经 role-action-queries 触达 db client；本测试只验证
// 纯派生逻辑，mock 掉池创建即可。
vi.mock("@/lib/db/client", () => ({ db: {} }));

const { ACTION_RESOURCE_TYPES } = await import("@/lib/identity/action-codes");
const { NAV_ACTION_MAPPING } = await import("@/lib/studio/nav-visibility");
const { STUDIO_ADMIN_FULL_ACTION_CODES, adminWildcardScopeType } = await import("@/lib/db/seed");

describe("引导管理员全量 Studio 授权派生", () => {
  it("授权集覆盖导航全部菜单动作（S11-W01 同源）", () => {
    for (const codes of Object.values(NAV_ACTION_MAPPING)) {
      for (const code of codes) {
        expect(STUDIO_ADMIN_FULL_ACTION_CODES).toContain(code);
      }
    }
  });

  it("授权集去重且全部为目录内动作", () => {
    expect(new Set(STUDIO_ADMIN_FULL_ACTION_CODES).size).toBe(
      STUDIO_ADMIN_FULL_ACTION_CODES.length,
    );
    for (const code of STUDIO_ADMIN_FULL_ACTION_CODES) {
      expect(ACTION_RESOURCE_TYPES[code]).toBeDefined();
    }
  });

  it("每个授权都能推导出目录允许的 wildcard scope type", () => {
    for (const code of STUDIO_ADMIN_FULL_ACTION_CODES) {
      const scopeType = adminWildcardScopeType(code);
      expect(ACTION_RESOURCE_TYPES[code]).toContain(scopeType);
    }
  });
});
