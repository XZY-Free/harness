import { beforeEach, describe, expect, it, vi } from "vitest";

const studio = vi.hoisted(() => ({
  requireStudioAction: vi.fn(),
  hasStudioAction: vi.fn(),
}));
const queries = vi.hoisted(() => ({
  getSkillById: vi.fn(),
  getSkillVersion: vi.fn(),
  setCurrentVersion: vi.fn(),
}));
const audit = vi.hoisted(() => ({ recordAdminAudit: vi.fn() }));

vi.mock("@/lib/identity/studio-access", () => ({
  requireStudioAction: studio.requireStudioAction,
  hasStudioAction: studio.hasStudioAction,
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

import { POST } from "@/app/studio/api/skills/[id]/publish/route";
import { NextRequest } from "next/server";

const PRINCIPAL = { userIdentityId: "u1", tenantId: "t1" };

function postReq(body: unknown) {
  return new NextRequest("http://localhost/studio/api/skills/s1/publish", {
    method: "POST",
    body: JSON.stringify(body),
    headers: { "content-type": "application/json" },
  });
}

beforeEach(() => {
  vi.clearAllMocks();
  studio.requireStudioAction.mockResolvedValue({ ok: true, principal: PRINCIPAL });
  studio.hasStudioAction.mockResolvedValue(true);
  queries.setCurrentVersion.mockResolvedValue(true);
  audit.recordAdminAudit.mockResolvedValue(true);
});

describe("POST /studio/api/skills/[id]/publish (切片 C)", () => {
  it("skill.write 通过 → 切换 currentVersionId + succeeded 审计", async () => {
    queries.getSkillById.mockResolvedValue({ id: "s1", currentVersionId: "v1" });
    queries.getSkillVersion.mockResolvedValue({ id: "v2", skillId: "s1", version: 2 });
    const res = await POST(postReq({ versionId: "v2" }), { params: Promise.resolve({ id: "s1" }) });
    expect(res.status).toBe(200);
    expect(queries.setCurrentVersion).toHaveBeenCalledTimes(1);
    expect(queries.setCurrentVersion).toHaveBeenCalledWith("s1", "v2", "v1");
    expect(audit.recordAdminAudit).toHaveBeenCalledWith(
      expect.objectContaining({
        action: "skills.published",
        targetType: "skill",
        targetId: "s1",
        outcome: "succeeded",
        metadata: { versionId: "v2" },
      }),
    );
  });

  it("foreign versionId（不属于该 skill）→ 404，不切换，写 failed 审计", async () => {
    queries.getSkillById.mockResolvedValue({ id: "s1", currentVersionId: "v1" });
    queries.getSkillVersion.mockResolvedValue({ id: "v2", skillId: "other", version: 2 });
    const res = await POST(postReq({ versionId: "v2" }), { params: Promise.resolve({ id: "s1" }) });
    expect(res.status).toBe(404);
    expect(queries.setCurrentVersion).not.toHaveBeenCalled();
    expect(audit.recordAdminAudit).toHaveBeenCalledWith(
      expect.objectContaining({
        action: "skills.published",
        outcome: "failed",
        metadata: expect.objectContaining({ reasonCode: "version_not_found", versionId: "v2" }),
      }),
    );
  });

  it("skill 不存在 → 404，不审计（无 skill id 锚点）", async () => {
    queries.getSkillById.mockResolvedValue(null);
    const res = await POST(postReq({ versionId: "v2" }), { params: Promise.resolve({ id: "s1" }) });
    expect(res.status).toBe(404);
    expect(audit.recordAdminAudit).not.toHaveBeenCalled();
  });

  it("缺 versionId → 400，不审计", async () => {
    const res = await POST(postReq({}), { params: Promise.resolve({ id: "s1" }) });
    expect(res.status).toBe(400);
    expect(queries.setCurrentVersion).not.toHaveBeenCalled();
    expect(audit.recordAdminAudit).not.toHaveBeenCalled();
  });

  it("无 skill.write → 403，不审计", async () => {
    studio.requireStudioAction.mockResolvedValue({
      ok: false,
      response: new Response("{}", { status: 403 }),
    });
    const res = await POST(postReq({ versionId: "v2" }), { params: Promise.resolve({ id: "s1" }) });
    expect(res.status).toBe(403);
    expect(queries.setCurrentVersion).not.toHaveBeenCalled();
    expect(audit.recordAdminAudit).not.toHaveBeenCalled();
  });

  it("审计写入失败 → 500 audit_failed", async () => {
    queries.getSkillById.mockResolvedValue({ id: "s1", currentVersionId: "v1" });
    queries.getSkillVersion.mockResolvedValue({ id: "v2", skillId: "s1", version: 2 });
    audit.recordAdminAudit.mockRejectedValue(new Error("audit write failed"));
    const res = await POST(postReq({ versionId: "v2" }), { params: Promise.resolve({ id: "s1" }) });
    expect(res.status).toBe(500);
    expect((await res.json()).error.code).toBe("audit_failed");
  });

  it("P1-5: 非 admin 且非 owner → 403,不切换版本", async () => {
    studio.hasStudioAction.mockResolvedValue(false);
    queries.getSkillById.mockResolvedValue({ id: "s1", ownerUserId: "other-user" });
    const res = await POST(postReq({ versionId: "v2" }), { params: Promise.resolve({ id: "s1" }) });
    expect(res.status).toBe(403);
    expect(queries.setCurrentVersion).not.toHaveBeenCalled();
  });

  it("P1-14: CAS 冲突(currentVersionId 已被并发改)→ 409", async () => {
    queries.getSkillById.mockResolvedValue({ id: "s1", currentVersionId: "v1" });
    queries.getSkillVersion.mockResolvedValue({ id: "v2", skillId: "s1", version: 2 });
    queries.setCurrentVersion.mockResolvedValueOnce(false);
    const res = await POST(postReq({ versionId: "v2" }), { params: Promise.resolve({ id: "s1" }) });
    expect(res.status).toBe(409);
    expect((await res.json()).error.code).toBe("version_conflict");
  });
});
