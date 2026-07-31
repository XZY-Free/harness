import { beforeEach, describe, expect, it, vi } from "vitest";

const rbac = vi.hoisted(() => ({ requirePermission: vi.fn() }));
const studio = vi.hoisted(() => ({ getPolicyConfigRows: vi.fn() }));
const queries = vi.hoisted(() => ({ replacePolicyConfigRows: vi.fn() }));
const config = vi.hoisted(() => ({ refreshPolicyConfigFromDB: vi.fn() }));
const audit = vi.hoisted(() => ({ recordAdminAudit: vi.fn() }));

vi.mock("@/lib/rbac", () => ({ requirePermission: rbac.requirePermission }));
vi.mock("@/lib/db/studio-queries", () => ({ getPolicyConfigRows: studio.getPolicyConfigRows }));
vi.mock("@/lib/db/queries", () => ({
  replacePolicyConfigRows: queries.replacePolicyConfigRows,
}));
vi.mock("@/lib/policy/config", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/lib/policy/config")>();
  return { ...actual, refreshPolicyConfigFromDB: config.refreshPolicyConfigFromDB };
});
vi.mock("@/lib/studio/admin-audit", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/lib/studio/admin-audit")>();
  return { ...actual, recordAdminAudit: audit.recordAdminAudit };
});
vi.mock("@/lib/logger", () => ({
  logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn() },
}));

import { GET, PUT } from "@/app/studio/api/policies/route";
import { defaultPolicyRows } from "@/lib/policy/config";
import { NextRequest } from "next/server";

const USER = { id: "u1", email: "a@x", name: "A", externalId: "u1", createdAt: new Date() };

type NextInit = NonNullable<ConstructorParameters<typeof NextRequest>[1]>;

function req(url: string, init?: NextInit) {
  return new NextRequest(url, init);
}

/** 取 rows 中指定 key 的行（缺失则抛错，避免 non-null assertion）。 */
function findRow(rows: { key: string; value: unknown }[], key: string) {
  const r = rows.find((x) => x.key === key);
  if (!r) throw new Error(`missing row: ${key}`);
  return r;
}

beforeEach(() => {
  vi.clearAllMocks();
  rbac.requirePermission.mockResolvedValue({ ok: true, user: USER });
  queries.replacePolicyConfigRows.mockResolvedValue(undefined);
  config.refreshPolicyConfigFromDB.mockResolvedValue(undefined);
  audit.recordAdminAudit.mockResolvedValue(undefined);
  studio.getPolicyConfigRows.mockResolvedValue(defaultPolicyRows());
});

describe("GET /studio/api/policies (Stage E)", () => {
  it("policy.read 通过 → 200 + 配置行", async () => {
    studio.getPolicyConfigRows.mockResolvedValue([
      { key: "protectedPaths", value: ["^\\.git(\\/|$)"], updatedAt: new Date() },
      {
        key: "formatOnWrite",
        value: { enabled: true, command: "prettier --write" },
        updatedAt: new Date(),
      },
    ]);
    const res = await GET(req("http://localhost/studio/api/policies"));
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.data.rows).toHaveLength(2);
    expect(rbac.requirePermission).toHaveBeenCalledWith(expect.anything(), "policy.read");
  });

  it("无 policy.read → 403", async () => {
    rbac.requirePermission.mockResolvedValue({
      ok: false,
      response: new Response("{}", { status: 403 }),
    });
    const res = await GET(req("http://localhost/studio/api/policies"));
    expect(res.status).toBe(403);
    expect(studio.getPolicyConfigRows).not.toHaveBeenCalled();
  });
});

describe("PUT /studio/api/policies (切片 B3)", () => {
  function put(body: unknown) {
    return req("http://localhost/studio/api/policies", {
      method: "PUT",
      body: JSON.stringify(body),
      headers: { "content-type": "application/json" },
    });
  }

  it("无 policy.write → 403，不校验不写入不审计", async () => {
    rbac.requirePermission.mockResolvedValue({
      ok: false,
      response: new Response("{}", { status: 403 }),
    });
    const res = await PUT(put({ rows: defaultPolicyRows() }));
    expect(res.status).toBe(403);
    expect(queries.replacePolicyConfigRows).not.toHaveBeenCalled();
    expect(config.refreshPolicyConfigFromDB).not.toHaveBeenCalled();
    expect(audit.recordAdminAudit).not.toHaveBeenCalled();
  });

  it("合法整配置 → 200 + 写入 + refresh + succeeded 审计", async () => {
    const res = await PUT(put({ rows: defaultPolicyRows() }));
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.data.rows).toHaveLength(4);
    expect(rbac.requirePermission).toHaveBeenCalledWith(expect.anything(), "policy.write");
    expect(queries.replacePolicyConfigRows).toHaveBeenCalledTimes(1);
    const firstCall = queries.replacePolicyConfigRows.mock.calls[0];
    const written = (firstCall ?? [])[0] as Array<{ key: string }>;
    expect(written.map((r) => r.key)).toEqual([
      "protectedPaths",
      "commandDenyList",
      "formatOnWrite",
      "verifyBeforeDelivery",
    ]);
    expect(config.refreshPolicyConfigFromDB).toHaveBeenCalledTimes(1);
    expect(audit.recordAdminAudit).toHaveBeenCalledWith(
      expect.objectContaining({
        action: "policies.updated",
        outcome: "succeeded",
        metadata: expect.objectContaining({
          keys: expect.any(Array),
          changedKeys: expect.any(Array),
        }),
      }),
    );
  });

  it("审计 metadata 不含命令全文 / secret", async () => {
    await PUT(put({ rows: defaultPolicyRows() }));
    const arg = audit.recordAdminAudit.mock.calls[0]?.[0] as { metadata: Record<string, unknown> };
    const serialized = JSON.stringify(arg.metadata);
    expect(serialized).not.toMatch(/prettier/i);
    expect(serialized).not.toMatch(/apiKey|password|secret|token/i);
  });

  it("非法 JSON body → 400 invalid_body，不审计", async () => {
    const r = req("http://localhost/studio/api/policies", {
      method: "PUT",
      body: "{not json",
      headers: { "content-type": "application/json" },
    });
    const res = await PUT(r);
    expect(res.status).toBe(400);
    expect((await res.json()).error.code).toBe("invalid_body");
    expect(audit.recordAdminAudit).not.toHaveBeenCalled();
  });

  it("非法 regex → 400 invalid_policy，不写入不 refresh，写 failed 审计", async () => {
    const rows = defaultPolicyRows();
    findRow(rows, "protectedPaths").value = ["["];
    const res = await PUT(put({ rows }));
    expect(res.status).toBe(400);
    expect((await res.json()).error.code).toBe("invalid_policy");
    expect(queries.replacePolicyConfigRows).not.toHaveBeenCalled();
    expect(config.refreshPolicyConfigFromDB).not.toHaveBeenCalled();
    expect(audit.recordAdminAudit).toHaveBeenCalledWith(
      expect.objectContaining({
        action: "policies.updated",
        outcome: "failed",
        metadata: expect.objectContaining({ reasonCode: "invalid_policy" }),
      }),
    );
  });

  it("审计写入失败 → 500 audit_failed", async () => {
    audit.recordAdminAudit.mockRejectedValue(new Error("audit write failed"));
    const res = await PUT(put({ rows: defaultPolicyRows() }));
    expect(res.status).toBe(500);
    expect((await res.json()).error.code).toBe("audit_failed");
  });

  it("未知 key → 400 invalid_policy", async () => {
    const res = await PUT(put({ rows: [...defaultPolicyRows(), { key: "evil", value: "x" }] }));
    expect(res.status).toBe(400);
    expect((await res.json()).error.code).toBe("invalid_policy");
  });

  it("缺少 key → 400 invalid_policy", async () => {
    const rows = defaultPolicyRows().filter((r) => r.key !== "formatOnWrite");
    const res = await PUT(put({ rows }));
    expect(res.status).toBe(400);
    expect((await res.json()).error.code).toBe("invalid_policy");
  });

  it("timeout 越界 → 400 invalid_policy", async () => {
    const rows = defaultPolicyRows();
    const v = findRow(rows, "verifyBeforeDelivery").value as Record<string, unknown>;
    v.timeoutMs = 10;
    const res = await PUT(put({ rows }));
    expect(res.status).toBe(400);
    expect((await res.json()).error.code).toBe("invalid_policy");
  });
});
