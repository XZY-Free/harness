import type { MemoryEntry } from "@/lib/db/schema";
import { beforeEach, describe, expect, it, vi } from "vitest";

const rbac = vi.hoisted(() => ({ requirePermission: vi.fn(), hasPermission: vi.fn() }));
const queries = vi.hoisted(() => ({ getThreadById: vi.fn(), requireThreadForUser: vi.fn() }));
const store = vi.hoisted(() => ({
  getMemory: vi.fn(),
  revokeMemory: vi.fn(),
  updateConfidence: vi.fn(),
}));

vi.mock("@/lib/rbac", () => ({
  requirePermission: rbac.requirePermission,
  hasPermission: rbac.hasPermission,
}));
vi.mock("@/lib/db/queries", () => ({
  getThreadById: queries.getThreadById,
  requireThreadForUser: queries.requireThreadForUser,
}));
vi.mock("@/lib/memory/store", () => ({
  getMemory: store.getMemory,
  revokeMemory: store.revokeMemory,
  updateConfidence: store.updateConfidence,
}));

import { POST } from "@/app/studio/api/threads/[id]/memories/[memoryId]/route";
import { NextRequest } from "next/server";

const USER = { id: "u1", email: "a@x", name: "A", externalId: "u1", createdAt: new Date() };

function mem(over: Partial<MemoryEntry>): MemoryEntry {
  return {
    id: "m1",
    scope: "thread",
    scopeRef: "t1",
    kind: "convention",
    text: "x",
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

function req(body: unknown) {
  return new NextRequest("http://localhost/x", {
    method: "POST",
    body: JSON.stringify(body),
  });
}

beforeEach(() => {
  vi.clearAllMocks();
  rbac.requirePermission.mockResolvedValue({ ok: true, user: USER });
  rbac.hasPermission.mockResolvedValue(false);
  queries.requireThreadForUser.mockResolvedValue({ id: "t1", userId: "u1" });
  queries.getThreadById.mockResolvedValue(null);
});

describe("POST .../memories/[memoryId]/resolve (Stage E)", () => {
  it("revoke active → 200", async () => {
    store.getMemory.mockResolvedValue(mem({ id: "m1", status: "active" }));
    store.revokeMemory.mockResolvedValue(mem({ id: "m1", status: "revoked" }));
    const res = await POST(req({ action: "revoke", reason: "过时" }), {
      params: Promise.resolve({ id: "t1", memoryId: "m1" }),
    });
    expect(res.status).toBe(200);
    expect(store.revokeMemory).toHaveBeenCalledWith("m1", { reason: "过时", revokedBy: "u1" });
  });

  it("revoke 已 revoked → 409", async () => {
    store.getMemory.mockResolvedValue(mem({ id: "m1", status: "revoked" }));
    const res = await POST(req({ action: "revoke" }), {
      params: Promise.resolve({ id: "t1", memoryId: "m1" }),
    });
    expect(res.status).toBe(409);
    expect(store.revokeMemory).not.toHaveBeenCalled();
  });

  it("update confidence → 200", async () => {
    store.getMemory.mockResolvedValue(mem({ id: "m1" }));
    store.updateConfidence.mockResolvedValue(mem({ id: "m1", confidence: "high" }));
    const res = await POST(req({ action: "update", confidence: "high" }), {
      params: Promise.resolve({ id: "t1", memoryId: "m1" }),
    });
    expect(res.status).toBe(200);
    expect(store.updateConfidence).toHaveBeenCalledWith("m1", "high");
  });

  it("memory 不存在 → 404", async () => {
    store.getMemory.mockResolvedValue(null);
    const res = await POST(req({ action: "revoke" }), {
      params: Promise.resolve({ id: "t1", memoryId: "nope" }),
    });
    expect(res.status).toBe(404);
  });

  it("thread 不存在 → 404", async () => {
    queries.requireThreadForUser.mockResolvedValue(null);
    const res = await POST(req({ action: "revoke" }), {
      params: Promise.resolve({ id: "t1", memoryId: "m1" }),
    });
    expect(res.status).toBe(404);
  });

  it("无 studio 权限 → 403", async () => {
    rbac.requirePermission.mockResolvedValue({
      ok: false,
      response: new Response("403", { status: 403 }),
    });
    const res = await POST(req({ action: "revoke" }), {
      params: Promise.resolve({ id: "t1", memoryId: "m1" }),
    });
    expect(res.status).toBe(403);
  });

  it("bad action → 400", async () => {
    store.getMemory.mockResolvedValue(mem({ id: "m1" }));
    const res = await POST(req({ action: "noop" }), {
      params: Promise.resolve({ id: "t1", memoryId: "m1" }),
    });
    expect(res.status).toBe(400);
  });

  it("P1-4 IDOR: thread scope memory 属于别的 thread → 404", async () => {
    store.getMemory.mockResolvedValue(mem({ id: "m1", scope: "thread", scopeRef: "t2" }));
    const res = await POST(req({ action: "revoke" }), {
      params: Promise.resolve({ id: "t1", memoryId: "m1" }),
    });
    expect(res.status).toBe(404);
    expect(store.revokeMemory).not.toHaveBeenCalled();
  });

  it("P1-4 IDOR: user scope memory 属于别的用户 → 404", async () => {
    store.getMemory.mockResolvedValue(mem({ id: "m1", scope: "user", scopeRef: "other-user" }));
    const res = await POST(req({ action: "revoke" }), {
      params: Promise.resolve({ id: "t1", memoryId: "m1" }),
    });
    expect(res.status).toBe(404);
  });

  it("P1-4: thread scope memory 属于当前 thread → 放行", async () => {
    store.getMemory.mockResolvedValue(
      mem({ id: "m1", scope: "thread", scopeRef: "t1", status: "active" }),
    );
    store.revokeMemory.mockResolvedValue(mem({ id: "m1", status: "revoked" }));
    const res = await POST(req({ action: "revoke" }), {
      params: Promise.resolve({ id: "t1", memoryId: "m1" }),
    });
    expect(res.status).toBe(200);
  });
});
