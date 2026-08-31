import { readFileSync } from "node:fs";
import { join } from "node:path";
import { db } from "@/lib/db/client";
import { seedDefaultGrants, seedDefaultIdentity } from "@/lib/db/seed";
import { resetDatabase } from "@/lib/db/test/mysql-harness";
import { agentTable } from "@/lib/persistence/schema/agents";
import { roleActionBinding } from "@/lib/persistence/schema/authorization";
import { tenant, userIdentity } from "@/lib/persistence/schema/identity";
import { sql } from "drizzle-orm";
import { beforeEach, describe, expect, it } from "vitest";

const manifest = JSON.parse(
  readFileSync(
    join(process.cwd(), "docs/implementation/topic-01-loop-schema/07-final-schema-manifest.json"),
    "utf8",
  ),
) as { tableCount: number; tables: string[] };

beforeEach(async () => {
  await resetDatabase(db);
});

describe("Fresh MySQL Schema", () => {
  it("empty MySQL migrate 后的物理表与最终 manifest 完全一致", async () => {
    const [rows] = (await db.execute(sql`SHOW TABLES`)) as unknown as [Record<string, string>[]];
    const actual = rows
      .map((row) => String(Object.values(row)[0]))
      .filter((name) => !name.startsWith("__"))
      .sort();
    expect(actual).toHaveLength(manifest.tableCount);
    expect(actual).toEqual(manifest.tables);
  });

  it("seed 从空库创建身份与权限，不创建默认 Agent", async () => {
    const identity = await seedDefaultIdentity();
    await seedDefaultGrants(identity.tenantId, identity.principalBindingId);

    const [tenantRows, identityRows, grantRows, agentRows] = await Promise.all([
      db.select().from(tenant),
      db.select().from(userIdentity),
      db.select().from(roleActionBinding),
      db.select().from(agentTable),
    ]);
    expect(tenantRows).toHaveLength(1);
    expect(identityRows).toHaveLength(1);
    expect(grantRows.length).toBeGreaterThan(0);
    expect(agentRows).toHaveLength(0);
  });
});
