import { beforeEach, describe, expect, it, vi } from "vitest";

const studio = vi.hoisted(() => ({
  requireStudioAction: vi.fn(),
  hasStudioAction: vi.fn(),
}));
const studioQueries = vi.hoisted(() => ({ listSkillVersions: vi.fn() }));

vi.mock("@/lib/identity/studio-access", () => ({
  requireStudioAction: studio.requireStudioAction,
  hasStudioAction: studio.hasStudioAction,
}));
vi.mock("@/lib/capability/skill-studio-queries", () => ({
  listSkillVersions: studioQueries.listSkillVersions,
}));

import { GET } from "@/app/studio/api/skills/[id]/versions/route";
import { NextRequest } from "next/server";

const PRINCIPAL = { userIdentityId: "u1", tenantId: "t1" };

beforeEach(() => {
  vi.clearAllMocks();
  studio.requireStudioAction.mockResolvedValue({ ok: true, principal: PRINCIPAL });
});

describe("GET /studio/api/skills/[id]/versions (Stage B)", () => {
  it("通过 → 200 + 版本列表（按 version asc）", async () => {
    studioQueries.listSkillVersions.mockResolvedValue([
      { id: "v1", versionNo: 1 },
      { id: "v2", versionNo: 2 },
    ]);
    const res = await GET(new NextRequest("http://localhost/studio/api/skills/s1/versions"), {
      params: Promise.resolve({ id: "s1" }),
    });
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.data).toHaveLength(2);
    expect(studioQueries.listSkillVersions).toHaveBeenCalledWith("t1", "s1");
  });

  it("无 skill.read → 403", async () => {
    studio.requireStudioAction.mockResolvedValue({
      ok: false,
      response: new Response("{}", { status: 403 }),
    });
    const res = await GET(new NextRequest("http://localhost/studio/api/skills/s1/versions"), {
      params: Promise.resolve({ id: "s1" }),
    });
    expect(res.status).toBe(403);
    expect(studioQueries.listSkillVersions).not.toHaveBeenCalled();
  });
});
