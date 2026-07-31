import type { MemoryEntry } from "@/lib/db/schema";
import { beforeEach, describe, expect, it, vi } from "vitest";

const rbac = vi.hoisted(() => ({ requirePermission: vi.fn(), hasPermission: vi.fn() }));
const queries = vi.hoisted(() => ({ getThreadById: vi.fn(), requireThreadForUser: vi.fn() }));
const store = vi.hoisted(() => ({ listMemories: vi.fn() }));

vi.mock("@/lib/rbac", () => ({
  requirePermission: rbac.requirePermission,
  hasPermission: rbac.hasPermission,
}));
vi.mock("@/lib/db/queries", () => ({
  getThreadById: queries.getThreadById,
  requireThreadForUser: queries.requireThreadForUser,
}));
vi.mock("@/lib/memory/store", () => ({ listMemories: store.listMemories }));

import { GET } from "@/app/studio/api/threads/[id]/memories/route";
import { NextRequest } from "next/server";

const USER = { id: "u1", email: "a@x", name: "A", externalId: "u1", createdAt: new Date() };

function mem(over: Partial<MemoryEntry>): MemoryEntry {
  return {
    id: "m1",
    scope: "user",
    scopeRef: "u1",
    kind: "convention",
    text: "commit 用 Lore",
    textHash: "h",
    provenance: [{ kind: "user", refId: "u1" }],
    confidence: "medium",
    status: "active",
    expiresAt: null,
    createdByToolRunId: null,
    createdAt: new Date(),
    updatedAt: new Date(),
    ...over,
  } as MemoryEntry;
}

beforeEach(() => {
  vi.clearAllMocks();
  rbac.requirePermission.mockResolvedValue({ ok: true, user: USER });
  rbac.hasPermission.mockResolvedValue(false);
  queries.requireThreadForUser.mockResolvedValue({ id: "t1", userId: "u1" });
  queries.getThreadById.mockResolvedValue(null);
});

describe("GET /studio/api/threads/[id]/memories (Stage E)", () => {
  it("owner → 200 + memories（user + thread scope）", async () => {
    store.listMemories.mockImplementation(async (f: { scope: string }) =>
      f.scope === "user"
        ? [mem({ id: "m1", scope: "user" })]
        : [mem({ id: "m2", scope: "thread", scopeRef: "t1" })],
    );
    const res = await GET(new NextRequest("http://localhost/x"), {
      params: Promise.resolve({ id: "t1" }),
    });
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.data.memories).toHaveLength(2);
    expect(body.data.memories.map((m: { id: string }) => m.id).sort()).toEqual(["m1", "m2"]);
  });

  it("无 studio 权限 → 403", async () => {
    rbac.requirePermission.mockResolvedValue({
      ok: false,
      response: new Response("403", { status: 403 }),
    });
    const res = await GET(new NextRequest("http://localhost/x"), {
      params: Promise.resolve({ id: "t1" }),
    });
    expect(res.status).toBe(403);
  });

  it("thread 不存在（foreign）→ 404，不泄露存在性", async () => {
    queries.requireThreadForUser.mockResolvedValue(null);
    const res = await GET(new NextRequest("http://localhost/x"), {
      params: Promise.resolve({ id: "t1" }),
    });
    expect(res.status).toBe(404);
  });

  it("admin（thread.read.all）→ getThreadById 取数", async () => {
    rbac.hasPermission.mockResolvedValue(true);
    queries.getThreadById.mockResolvedValue({ id: "t1", userId: "other" });
    store.listMemories.mockResolvedValue([]);
    const res = await GET(new NextRequest("http://localhost/x"), {
      params: Promise.resolve({ id: "t1" }),
    });
    expect(res.status).toBe(200);
    expect(queries.getThreadById).toHaveBeenCalledWith("t1");
  });
});
