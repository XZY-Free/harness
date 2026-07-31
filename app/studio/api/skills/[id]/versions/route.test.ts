import { beforeEach, describe, expect, it, vi } from "vitest";

const rbac = vi.hoisted(() => ({ requirePermission: vi.fn(), hasPermission: vi.fn() }));
const studio = vi.hoisted(() => ({ listSkillVersions: vi.fn() }));

vi.mock("@/lib/rbac", () => ({
  requirePermission: rbac.requirePermission,
  hasPermission: rbac.hasPermission,
}));
vi.mock("@/lib/db/studio-queries", () => ({ listSkillVersions: studio.listSkillVersions }));

import { GET } from "@/app/studio/api/skills/[id]/versions/route";
import { NextRequest } from "next/server";

const USER = { id: "u1", email: "a@x", name: "A", externalId: "u1", createdAt: new Date() };

beforeEach(() => {
  vi.clearAllMocks();
  rbac.requirePermission.mockResolvedValue({ ok: true, user: USER });
});

describe("GET /studio/api/skills/[id]/versions (Stage B)", () => {
  it("通过 → 200 + 版本列表（按 version asc）", async () => {
    studio.listSkillVersions.mockResolvedValue([
      { id: "v1", version: 1 },
      { id: "v2", version: 2 },
    ]);
    const res = await GET(new NextRequest("http://localhost/studio/api/skills/s1/versions"), {
      params: Promise.resolve({ id: "s1" }),
    });
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.data).toHaveLength(2);
    expect(studio.listSkillVersions).toHaveBeenCalledWith("s1");
  });

  it("无 skill.read → 403", async () => {
    rbac.requirePermission.mockResolvedValue({
      ok: false,
      response: new Response("{}", { status: 403 }),
    });
    const res = await GET(new NextRequest("http://localhost/studio/api/skills/s1/versions"), {
      params: Promise.resolve({ id: "s1" }),
    });
    expect(res.status).toBe(403);
    expect(studio.listSkillVersions).not.toHaveBeenCalled();
  });
});
