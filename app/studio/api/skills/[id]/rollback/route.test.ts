import { beforeEach, describe, expect, it, vi } from "vitest";

const studio = vi.hoisted(() => ({
  requireStudioAction: vi.fn(),
  hasStudioAction: vi.fn(),
}));
const skillQryMocks = vi.hoisted(() => ({
  getSkillById: vi.fn(),
  getSkillVersionById: vi.fn(),
  setCurrentSkillVersion: vi.fn(),
}));
const audit = vi.hoisted(() => ({ recordAdminAudit: vi.fn() }));

vi.mock("@/lib/identity/studio-access", () => ({
  requireStudioAction: studio.requireStudioAction,
  hasStudioAction: studio.hasStudioAction,
}));
vi.mock("@/lib/capability/skill-queries", () => ({
  getSkillById: skillQryMocks.getSkillById,
  getSkillVersionById: skillQryMocks.getSkillVersionById,
  setCurrentSkillVersion: skillQryMocks.setCurrentSkillVersion,
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

const PRINCIPAL = { userIdentityId: "u1", tenantId: "t1" };

function postReq(body: unknown) {
  return new NextRequest("http://localhost/studio/api/skills/s1/rollback", {
    method: "POST",
    body: JSON.stringify(body),
    headers: { "content-type": "application/json" },
  });
}

beforeEach(() => {
  vi.clearAllMocks();
  studio.requireStudioAction.mockResolvedValue({ ok: true, principal: PRINCIPAL });
  studio.hasStudioAction.mockResolvedValue(true);
  skillQryMocks.setCurrentSkillVersion.mockResolvedValue(true);
  audit.recordAdminAudit.mockResolvedValue(true);
});

describe("POST /studio/api/skills/[id]/rollback (切片 C)", () => {
  it("skill.write 通过 → setCurrentSkillVersion 调一次 + succeeded 审计 rolled_back", async () => {
    skillQryMocks.getSkillById.mockResolvedValue({ id: "s1", currentVersionId: "v2" });
    skillQryMocks.getSkillVersionById.mockResolvedValue({ id: "v1", skillId: "s1", versionNo: 1 });
    const res = await POST(postReq({ versionId: "v1" }), { params: Promise.resolve({ id: "s1" }) });
    expect(res.status).toBe(200);
    expect(skillQryMocks.setCurrentSkillVersion).toHaveBeenCalledTimes(1);
    expect(skillQryMocks.setCurrentSkillVersion).toHaveBeenCalledWith({
      tenantId: "t1",
      skillId: "s1",
      skillVersionId: "v1",
      expectedCurrentVersionId: "v2",
    });
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
    skillQryMocks.getSkillById.mockResolvedValue({ id: "s1", currentVersionId: "v2" });
    skillQryMocks.getSkillVersionById.mockResolvedValue({
      id: "v1",
      skillId: "other",
      versionNo: 1,
    });
    const res = await POST(postReq({ versionId: "v1" }), { params: Promise.resolve({ id: "s1" }) });
    expect(res.status).toBe(404);
    expect(skillQryMocks.setCurrentSkillVersion).not.toHaveBeenCalled();
    expect(audit.recordAdminAudit).toHaveBeenCalledWith(
      expect.objectContaining({ outcome: "failed", action: "skills.rolled_back" }),
    );
  });

  it("无 skill.write → 403，不审计", async () => {
    studio.requireStudioAction.mockResolvedValue({
      ok: false,
      response: new Response("{}", { status: 403 }),
    });
    const res = await POST(postReq({ versionId: "v1" }), { params: Promise.resolve({ id: "s1" }) });
    expect(res.status).toBe(403);
    expect(skillQryMocks.setCurrentSkillVersion).not.toHaveBeenCalled();
    expect(audit.recordAdminAudit).not.toHaveBeenCalled();
  });
});
