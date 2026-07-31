import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { dbConfig } from "./config";

/**
 * S1（08-P2-5）：ContextSnapshot 独立短保留期 config 测试。
 *
 * 覆盖 dbConfig.snapshotRetentionDays getter：
 * - 默认 7（env 未设）
 * - env SNOW_DB_SNAPSHOT_RETENTION_DAYS 覆盖
 * - 非法值回退默认 7
 * - 0 = 禁用清理（合法值，不回退）
 * - 与 retentionDays(90) 独立互不影响
 */

const ORIG_RETENTION = process.env.SNOW_DB_RETENTION_DAYS;
const ORIG_SNAPSHOT_RETENTION = process.env.SNOW_DB_SNAPSHOT_RETENTION_DAYS;

beforeEach(() => {
  // 清空 env（用 undefined 赋值，避免 delete 操作符）
  process.env.SNOW_DB_RETENTION_DAYS = undefined;
  process.env.SNOW_DB_SNAPSHOT_RETENTION_DAYS = undefined;
});

afterEach(() => {
  // 还原原值
  process.env.SNOW_DB_RETENTION_DAYS = ORIG_RETENTION;
  process.env.SNOW_DB_SNAPSHOT_RETENTION_DAYS = ORIG_SNAPSHOT_RETENTION;
});

describe("dbConfig.snapshotRetentionDays (08-P2-5)", () => {
  it("默认 7（env 未设）", () => {
    expect(dbConfig.snapshotRetentionDays).toBe(7);
  });

  it("env SNOW_DB_SNAPSHOT_RETENTION_DAYS=30 → 30", () => {
    process.env.SNOW_DB_SNAPSHOT_RETENTION_DAYS = "30";
    expect(dbConfig.snapshotRetentionDays).toBe(30);
  });

  it("env=0 → 0（禁用清理，合法值不回退）", () => {
    process.env.SNOW_DB_SNAPSHOT_RETENTION_DAYS = "0";
    expect(dbConfig.snapshotRetentionDays).toBe(0);
  });

  it("非法值（非数字）→ 回退默认 7", () => {
    process.env.SNOW_DB_SNAPSHOT_RETENTION_DAYS = "not-a-number";
    expect(dbConfig.snapshotRetentionDays).toBe(7);
  });

  it("非法值（负数）→ 回退默认 7", () => {
    process.env.SNOW_DB_SNAPSHOT_RETENTION_DAYS = "-5";
    expect(dbConfig.snapshotRetentionDays).toBe(7);
  });

  it("与 retentionDays 独立：snapshotRetentionDays=7 不影响 retentionDays=90", () => {
    expect(dbConfig.snapshotRetentionDays).toBe(7);
    expect(dbConfig.retentionDays).toBe(90);
  });

  it("retentionDays=30 不影响 snapshotRetentionDays=7", () => {
    process.env.SNOW_DB_RETENTION_DAYS = "30";
    expect(dbConfig.retentionDays).toBe(30);
    expect(dbConfig.snapshotRetentionDays).toBe(7);
  });
});
