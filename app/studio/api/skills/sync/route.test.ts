import { beforeEach, describe, expect, it, vi } from "vitest";

/**
 * POST /studio/api/skills/sync 测试（02 文档 §5.1、§7.3）。
 * - 非 admin → 403
 * - endpoint 未配置 → 400 sync_not_configured
 * - runSync 成功 → 200 + 分组结果
 * - runSync 抛错 → 500 sync_failed
 */

const rbac = vi.hoisted(() => ({ requirePermission: vi.fn() }));
const configState = vi.hoisted(() => ({ endpoint: "https://cm.test/api" }));
const syncMocks = vi.hoisted(() => ({ runSync: vi.fn() }));

vi.mock("@/lib/rbac", () => ({ requirePermission: rbac.requirePermission }));
vi.mock("@/lib/config", () => ({
  capabilityMarketConfig: {
    get endpoint() {
      return configState.endpoint;
    },
  },
}));
vi.mock("@/lib/skill/sync/sync-service", () => ({ runSync: syncMocks.runSync }));
vi.mock("@/lib/skill/sync/capability-market-client", () => ({
  CapabilityMarketClientError: class extends Error {},
}));
vi.mock("@/lib/studio/admin-audit", () => ({ recordAdminAudit: vi.fn() }));
vi.mock("@/lib/logger", () => ({ logger: { warn: vi.fn(), error: vi.fn() } }));

import { POST } from "@/app/studio/api/skills/sync/route";
import { NextRequest } from "next/server";

const ADMIN = { id: "admin", email: "a@x", name: "A", externalId: "admin", createdAt: new Date() };
const req = () => new NextRequest("http://localhost/studio/api/skills/sync", { method: "POST" });

beforeEach(() => {
  vi.clearAllMocks();
  configState.endpoint = "https://cm.test/api";
  rbac.requirePermission.mockResolvedValue({ ok: true, user: ADMIN });
});

describe("POST /studio/api/skills/sync", () => {
  it("非 admin（无 skill.write.all）→ 403", async () => {
    rbac.requirePermission.mockResolvedValue({
      ok: false,
      response: new Response("{}", { status: 403 }),
    });
    const res = await POST(req());
    expect(res.status).toBe(403);
    expect(syncMocks.runSync).not.toHaveBeenCalled();
  });

  it("endpoint 未配置 → 400 sync_not_configured", async () => {
    configState.endpoint = "";
    const res = await POST(req());
    expect(res.status).toBe(400);
    const body = await res.json();
    expect(body.error.code).toBe("sync_not_configured");
  });

  it("runSync 成功 → 200 + 分组结果", async () => {
    const result = {
      imported: [{ remoteAssetId: "a1" }],
      updated: [],
      uptodate: [],
      conflict: [],
      blocked: [],
      failed: [],
      missing: [],
    };
    syncMocks.runSync.mockResolvedValue(result);
    const res = await POST(req());
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.ok).toBe(true);
    expect(body.data.imported).toHaveLength(1);
  });

  it("runSync 抛错 → 500 sync_failed", async () => {
    syncMocks.runSync.mockRejectedValue(new Error("网络错误"));
    const res = await POST(req());
    expect(res.status).toBe(500);
    const body = await res.json();
    expect(body.error.code).toBe("sync_failed");
  });
});
