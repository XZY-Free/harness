import { beforeEach, describe, expect, it, vi } from "vitest";

const studio = vi.hoisted(() => ({
  requireStudioAction: vi.fn(),
  hasStudioAction: vi.fn(),
  resolveStudioPrincipal: vi.fn(),
}));
const queries = vi.hoisted(() => ({ getSkillById: vi.fn(), getSkillVersion: vi.fn() }));

vi.mock("@/lib/identity/studio-access", () => ({
  requireStudioAction: studio.requireStudioAction,
  hasStudioAction: studio.hasStudioAction,
  resolveStudioPrincipal: studio.resolveStudioPrincipal,
}));
vi.mock("@/lib/db/queries", () => ({
  getSkillById: queries.getSkillById,
  getSkillVersion: queries.getSkillVersion,
}));

import { GET } from "@/app/studio/api/skills/[id]/route";
import { NextRequest } from "next/server";

const PRINCIPAL = { userIdentityId: "u1", tenantId: "t1" };
const req = () => new NextRequest("http://localhost/studio/api/skills/s1");

beforeEach(() => {
  vi.clearAllMocks();
  studio.requireStudioAction.mockResolvedValue({ ok: true, principal: PRINCIPAL });
});

describe("GET /studio/api/skills/[id] (Stage B)", () => {
  it("通过 → 200 + skill + currentVersion", async () => {
    queries.getSkillById.mockResolvedValue({ id: "s1", name: "sk", currentVersionId: "v2" });
    queries.getSkillVersion.mockResolvedValue({ id: "v2", version: 2 });
    const res = await GET(req(), { params: Promise.resolve({ id: "s1" }) });
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.data).toMatchObject({ skill: { id: "s1" }, currentVersion: { id: "v2" } });
  });

  it("skill 不存在 → 404", async () => {
    queries.getSkillById.mockResolvedValue(null);
    const res = await GET(req(), { params: Promise.resolve({ id: "s1" }) });
    expect(res.status).toBe(404);
  });

  it("无 skill.read → 403", async () => {
    studio.requireStudioAction.mockResolvedValue({
      ok: false,
      response: new Response("{}", { status: 403 }),
    });
    const res = await GET(req(), { params: Promise.resolve({ id: "s1" }) });
    expect(res.status).toBe(403);
    expect(queries.getSkillById).not.toHaveBeenCalled();
  });
});
