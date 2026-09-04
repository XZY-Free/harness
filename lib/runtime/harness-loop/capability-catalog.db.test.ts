import { db } from "@/lib/db/client";
import { sql } from "drizzle-orm";
import { describe, expect, it } from "vitest";

describe("ExecutionBinding capability catalog persistence", () => {
  it("fresh migration 创建不可空的快照、摘要、版本、来源和创建时间列", async () => {
    const [rows] = await db.execute(sql.raw(
      "SELECT COLUMN_NAME, IS_NULLABLE FROM information_schema.COLUMNS " +
        "WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = 'ExecutionBinding' " +
        "AND COLUMN_NAME IN ('capabilityCatalogJson','capabilityCatalogDigest','capabilityCatalogVersion','capabilityCatalogSourceRefs','capabilityCatalogCreatedAt')",
    ));
    const columns = new Map(
      (rows as unknown as Array<{ COLUMN_NAME: string; IS_NULLABLE: string }>).map((row) => [
        row.COLUMN_NAME,
        row.IS_NULLABLE,
      ]),
    );
    expect([...columns.keys()].sort()).toEqual([
      "capabilityCatalogCreatedAt",
      "capabilityCatalogDigest",
      "capabilityCatalogJson",
      "capabilityCatalogSourceRefs",
      "capabilityCatalogVersion",
    ]);
    expect([...columns.values()]).toEqual(["NO", "NO", "NO", "NO", "NO"]);
  });
});
