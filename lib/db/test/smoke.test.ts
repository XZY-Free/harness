import { db } from "@/lib/db/client";
import { sql } from "drizzle-orm";
import { beforeEach, describe, expect, it } from "vitest";
import { resetDatabase } from "./mysql-harness";

describe("mysql harness smoke", () => {
  beforeEach(async () => {
    await resetDatabase(db);
  });

  it("连接的是 MySQL 8（S01-W04 生产同构基线）", async () => {
    const [rows] = (await db.execute(sql`SELECT VERSION() AS v`)) as unknown as [
      Array<{ v: string }>,
    ];
    const version = rows[0]?.v;
    expect(version, `expected MySQL 8.x, got ${version}`).toMatch(/^8\./);
  });

  it("resetDatabase 后 Thread 表为空", async () => {
    const [rows] = (await db.execute(sql`SELECT COUNT(*) AS c FROM Thread`)) as unknown as [
      Array<{ c: number }>,
    ];
    expect(rows[0]?.c).toBe(0);
  });

  it("插 1 行 → reset → 归 0（隔离生效）", async () => {
    await db.execute(
      sql`INSERT INTO User (id, externalId, email, name, createdAt) VALUES ('u1','u1','u@x','U',NOW())`,
    );
    await db.execute(
      sql`INSERT INTO Thread (id, userId, title, status, createdAt, updatedAt) VALUES ('t1','u1','x','idle',NOW(),NOW())`,
    );
    await resetDatabase(db);
    const [rows] = (await db.execute(sql`SELECT COUNT(*) AS c FROM Thread`)) as unknown as [
      Array<{ c: number }>,
    ];
    expect(rows[0]?.c).toBe(0);
  });
});
