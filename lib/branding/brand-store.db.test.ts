import { fetchBrandRow } from "@/lib/branding/brand-queries";
import { createBrandStore } from "@/lib/branding/brand-store";
import { db } from "@/lib/db/client";
import { brandChangeAudit, brandSettings } from "@/lib/persistence/schema/branding";
import { afterAll, describe, expect, it } from "vitest";

afterAll(async () => {
  await db.delete(brandChangeAudit);
  await db.delete(brandSettings);
});

describe("BrandStore 真实 MySQL 持久化", () => {
  it("update 事务落库文档与审计，revision 单调递增", async () => {
    const store = createBrandStore({ env: {}, filePath: null, startPoll: false });

    const first = await store.update({ name: "Persisted One" }, "tester");
    expect(first.contract.revision).toBe(1);
    const second = await store.update({ tagline: "hello" }, "tester");
    expect(second.contract.revision).toBe(2);

    const row = await fetchBrandRow();
    expect(row?.revision).toBe(2);
    expect((row?.document as { name?: string }).name).toBe("Persisted One");
    expect(row?.updatedBy).toBe("tester");

    const audits = await db.select().from(brandChangeAudit);
    expect(audits.map((audit) => audit.revisionAfter)).toEqual([1, 2]);
    expect(audits[0]?.revisionBefore).toBe(0);
    expect(audits[1]?.patch).toMatchObject({ tagline: "hello" });
  });

  it("新 store 实例读取已持久化品牌（跨实例一致）", async () => {
    const fresh = createBrandStore({ env: {}, filePath: null, startPoll: false });
    const snapshot = await fresh.get();
    expect(snapshot.contract.name).toBe("Persisted One");
    expect(snapshot.contract.tagline).toBe("hello");
    expect(snapshot.contract.revision).toBe(2);
  });
});
