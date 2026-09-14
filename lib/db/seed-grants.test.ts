import { ACTION_RESOURCE_TYPES } from "@/lib/identity/action-codes";
import { ROLE_TEMPLATES, getRoleTemplate } from "@/lib/identity/role-templates";
import { describe, expect, it } from "vitest";

describe("内置职责边界", () => {
  it("所有内置授权动作与资源类型有效且不重复", () => {
    for (const role of ROLE_TEMPLATES) {
      expect(new Set(role.grants.map((g) => JSON.stringify(g))).size).toBe(role.grants.length);
      for (const grant of role.grants)
        expect(ACTION_RESOURCE_TYPES[grant.actionCode]).toContain(grant.resourceScope.type);
    }
  });
  it("管理员不隐含业务调用、跨用户会话和敏感导出权限", () => {
    const codes = getRoleTemplate("admin")?.grants.map((g) => g.actionCode) ?? [];
    for (const code of [
      "agent.invoke",
      "thread.read",
      "thread.write",
      "audit.export",
      "admin.export.create",
      "admin.export.download",
    ])
      expect(codes).not.toContain(code);
    expect(codes).toContain("user.manage");
    expect(codes).toContain("studio.access");
  });
  it("员工只有自己会话的基础权限", () => {
    expect(getRoleTemplate("member")?.grants).toEqual([
      { actionCode: "thread.read", resourceScope: { type: "self", wildcard: true } },
      { actionCode: "thread.write", resourceScope: { type: "self", wildcard: true } },
    ]);
  });
});
