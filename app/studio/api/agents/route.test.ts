import { beforeEach, describe, expect, it, vi } from "vitest";

/**
 * Phase 4-4 切片 B1 Stage B：Agents list API 守卫与取数。
 * mock rbac + queries，断言 agent.read 通过 → 200 { rows }；无权限 → 403；AuthError → 401。
 */

const rbac = vi.hoisted(() => ({ requirePermission: vi.fn() }));
const queries = vi.hoisted(() => ({ listAgents: vi.fn() }));

vi.mock("@/lib/rbac", () => ({ requirePermission: rbac.requirePermission }));
vi.mock("@/lib/db/queries", () => ({ listAgents: queries.listAgents }));

import { GET } from "@/app/studio/api/agents/route";
import { NextRequest } from "next/server";

const USER = { id: "u1", email: "a@x", name: "A", externalId: "u1", createdAt: new Date() };

beforeEach(() => {
  vi.clearAllMocks();
  rbac.requirePermission.mockResolvedValue({ ok: true, user: USER });
});

describe("GET /studio/api/agents (切片 B1)", () => {
  it("agent.read 通过 → 200 + { rows }", async () => {
    queries.listAgents.mockResolvedValue([
      { id: "a1", name: "default", model: "kimi-k2.7-code", config: {} },
    ]);
    const res = await GET(new NextRequest("http://localhost/studio/api/agents"));
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.data.rows).toEqual([
      { id: "a1", name: "default", model: "kimi-k2.7-code", config: {} },
    ]);
    expect(rbac.requirePermission).toHaveBeenCalledWith(expect.anything(), "agent.read");
  });

  it("无 agent.read → 403，不查 list", async () => {
    rbac.requirePermission.mockResolvedValue({
      ok: false,
      response: new Response("{}", { status: 403 }),
    });
    const res = await GET(new NextRequest("http://localhost/studio/api/agents"));
    expect(res.status).toBe(403);
    expect(queries.listAgents).not.toHaveBeenCalled();
  });

  it("AuthError → 401", async () => {
    rbac.requirePermission.mockResolvedValue({
      ok: false,
      response: new Response("{}", { status: 401 }),
    });
    const res = await GET(new NextRequest("http://localhost/studio/api/agents"));
    expect(res.status).toBe(401);
    expect(queries.listAgents).not.toHaveBeenCalled();
  });
});
