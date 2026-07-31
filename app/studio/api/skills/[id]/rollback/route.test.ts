import { beforeEach, describe, expect, it, vi } from "vitest";

const rbac = vi.hoisted(() => ({ requirePermission: vi.fn(), hasPermission: vi.fn() }));
const queries = vi.hoisted(() => ({
  getSkillById: vi.fn(),
  getSkillVersion: vi.fn(),
  setCurrentVersion: vi.fn(),
}));
const audit = vi.hoisted(() => ({ recordAdminAudit: vi.fn() }));

vi.mock("@/lib/rbac", () => ({
  requirePermission: rbac.requirePermission,
  hasPermission: rbac.hasPermission,
}));
vi.mock("@/lib/db/queries", () => ({
  getSkillById: queries.getSkillById,
  getSkillVersion: queries.getSkillVersion,
  setCurrentVersion: queries.setCurrentVersion,
}));
vi.mock("@/lib/studio/admin-audit", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/lib/studio/admin-audit")>();
  return { ...actual, recordAdminAudit: audit.recordAdminAudit };
});
vi.mock("@/lib/logger", () => ({
  logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn() },
}));

import { POST } from "@/app/studio/api/skills/[id]/rollback/route";
import { NextRequest } from "next/server";

const USER = { id: "u1", email: "a@x", name: "A", externalId: "u1", createdAt: new Date() };

function postReq(body: unknown) {
  return new NextRequest("http://localhost/studio/api/skills/s1/rollback", {
    method: "POST",
    body: JSON.stringify(body),
    headers: { "content-type": "application/json" },
  });
}

beforeEach(() => {
  vi.clearAllMocks();
  rbac.requirePermission.mockResolvedValue({ ok: true, user: USER });
  rbac.hasPermission.mockResolvedValue(true);
  queries.setCurrentVersion.mockResolvedValue(true);
  audit.recordAdminAudit.mockResolvedValue(true);
});

describe("POST /studio/api/skills/[id]/rollback (切片 C)", () => {
  it("skill.write 通过 → setCurrentVersion 调一次 + succeeded 审计 rolled_back", async () => {
    queries.getSkillById.mockResolvedValue({ id: "s1", currentVersionId: "v2" });
    queries.getSkillVersion.mockResolvedValue({ id: "v1", skillId: "s1", version: 1 });
    const res = await POST(postReq({ versionId: "v1" }), { params: Promise.resolve({ id: "s1" }) });
    expect(res.status).toBe(200);
    expect(queries.setCurrentVersion).toHaveBeenCalledTimes(1);
    expect(queries.setCurrentVersion).toHaveBeenCalledWith("s1", "v1", "v2");
    expect(audit.recordAdminAudit).toHaveBeenCalledWith(
      expect.objectContaining({
        action: "skills.rolled_back",
        targetId: "s1",
        outcome: "succeeded",
        metadata: expect.objectContaining({ versionId: "v1" }),
      }),
    );
  });

  it("foreign versionId → 404，不切换，写 failed 审计", async () => {
    queries.getSkillById.mockResolvedValue({ id: "s1", currentVersionId: "v2" });
    queries.getSkillVersion.mockResolvedValue({ id: "v1", skillId: "other", version: 1 });
    const res = await POST(postReq({ versionId: "v1" }), { params: Promise.resolve({ id: "s1" }) });
    expect(res.status).toBe(404);
    expect(queries.setCurrentVersion).not.toHaveBeenCalled();
    expect(audit.recordAdminAudit).toHaveBeenCalledWith(
      expect.objectContaining({ outcome: "failed", action: "skills.rolled_back" }),
    );
  });

  it("无 skill.write → 403，不审计", async () => {
    rbac.requirePermission.mockResolvedValue({
      ok: false,
      response: new Response("{}", { status: 403 }),
    });
    const res = await POST(postReq({ versionId: "v1" }), { params: Promise.resolve({ id: "s1" }) });
    expect(res.status).toBe(403);
    expect(queries.setCurrentVersion).not.toHaveBeenCalled();
    expect(audit.recordAdminAudit).not.toHaveBeenCalled();
  });
});
