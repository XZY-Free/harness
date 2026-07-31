import {
  AuthError,
  getCurrentUserFromRequest,
  resolveIdentityFromHeaders,
  upsertUserByIdentity,
} from "@/lib/auth";
import { DEFAULT_USER_EMAIL, DEFAULT_USER_ID, DEFAULT_USER_NAME } from "@/lib/constants";
import { db } from "@/lib/db/client";
import { user } from "@/lib/db/schema";
import { resetDatabase } from "@/lib/db/test/mysql-harness";
import { eq } from "drizzle-orm";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

/**
 * Phase 4-3 Stage A：auth 主体解析单测。
 *
 * - resolveIdentityFromHeaders：dev / trusted-headers 双模式 + 缺身份 / 缺邮箱报错（纯函数，无 DB）
 * - upsertUserByIdentity：命中复用、email/name 漂移 update、新身份 insert（真实 MySQL 同构）
 */

const ORIGINAL_MODE = process.env.SNOW_AUTH_MODE;

function setMode(mode: string | undefined) {
  process.env.SNOW_AUTH_MODE = mode;
}

beforeEach(async () => {
  await resetDatabase(db);
});

afterEach(() => {
  setMode(ORIGINAL_MODE);
});

describe("resolveIdentityFromHeaders", () => {
  it("dev 模式返回默认用户身份", () => {
    setMode("dev");
    const id = resolveIdentityFromHeaders(new Headers());
    expect(id.externalId).toBe(DEFAULT_USER_ID);
    expect(id.email).toBe(DEFAULT_USER_EMAIL);
    expect(id.name).toBe(DEFAULT_USER_NAME);
  });

  it("trusted-headers 读取配置的 header", () => {
    setMode("trusted-headers");
    const headers = new Headers();
    headers.set("x-snow-user-id", "emp-42");
    headers.set("x-snow-user-email", "a@example.com");
    headers.set("x-snow-user-name", "User A");
    const id = resolveIdentityFromHeaders(headers);
    expect(id).toEqual({ externalId: "emp-42", email: "a@example.com", name: "User A" });
  });

  it("trusted-headers 缺 user id → AuthError missing_identity", () => {
    setMode("trusted-headers");
    const headers = new Headers();
    headers.set("x-snow-user-email", "a@example.com");
    expect(() => resolveIdentityFromHeaders(headers)).toThrow(AuthError);
    try {
      resolveIdentityFromHeaders(headers);
    } catch (e) {
      expect((e as AuthError).code).toBe("missing_identity");
    }
  });

  it("trusted-headers 缺 email → AuthError missing_email", () => {
    setMode("trusted-headers");
    const headers = new Headers();
    headers.set("x-snow-user-id", "emp-42");
    expect(() => resolveIdentityFromHeaders(headers)).toThrow(AuthError);
    try {
      resolveIdentityFromHeaders(headers);
    } catch (e) {
      expect((e as AuthError).code).toBe("missing_email");
    }
  });

  it("trusted-headers header 值仅空白 → 视为缺失", () => {
    setMode("trusted-headers");
    const headers = new Headers();
    headers.set("x-snow-user-id", "   ");
    headers.set("x-snow-user-email", "a@example.com");
    expect(() => resolveIdentityFromHeaders(headers)).toThrow(AuthError);
  });
});

describe("upsertUserByIdentity (真实 MySQL)", () => {
  it("命中 externalId → 直接返回既有用户，不 insert", async () => {
    const now = new Date();
    await db.insert(user).values({
      id: "u-1",
      externalId: "emp-42",
      email: "a@example.com",
      name: "User A",
      createdAt: now,
    });

    const u = await upsertUserByIdentity({
      externalId: "emp-42",
      email: "a@example.com",
      name: "User A",
    });
    expect(u).toMatchObject({ id: "u-1", externalId: "emp-42" });

    const rows = await db.select().from(user);
    expect(rows).toHaveLength(1);
  });

  it("email/name 漂移 → update 既有用户", async () => {
    const now = new Date();
    await db.insert(user).values({
      id: "u-1",
      externalId: "emp-42",
      email: "old@example.com",
      name: "Old Name",
      createdAt: now,
    });

    const u = await upsertUserByIdentity({
      externalId: "emp-42",
      email: "new@example.com",
      name: "New Name",
    });
    expect(u.email).toBe("new@example.com");
    expect(u.name).toBe("New Name");
    expect(u.id).toBe("u-1");

    const [row] = await db.select().from(user).where(eq(user.id, "u-1"));
    expect(row?.email).toBe("new@example.com");
    expect(row?.name).toBe("New Name");
  });

  it("新 externalId → insert 新用户", async () => {
    const u = await upsertUserByIdentity({
      externalId: "emp-99",
      email: "b@example.com",
      name: "User B",
    });
    expect(u).toMatchObject({ externalId: "emp-99", email: "b@example.com" });
    expect(u.id).toBeTruthy();

    const rows = await db.select().from(user).where(eq(user.externalId, "emp-99"));
    expect(rows).toHaveLength(1);
  });

  it("dev 默认用户 insert 时复用 DEFAULT_USER_ID 作内部 id", async () => {
    const u = await upsertUserByIdentity({
      externalId: DEFAULT_USER_ID,
      email: DEFAULT_USER_EMAIL,
      name: DEFAULT_USER_NAME,
    });
    expect(u.id).toBe(DEFAULT_USER_ID);

    const [row] = await db.select().from(user).where(eq(user.id, DEFAULT_USER_ID));
    expect(row?.externalId).toBe(DEFAULT_USER_ID);
  });
});

describe("getCurrentUserFromRequest (真实 MySQL)", () => {
  it("trusted-headers 模式：仅凭 header 解析身份，无需来源 IP", async () => {
    // P1-1 修复回归：Next 16 移除 NextRequest.ip，应用层不再做来源校验。
    // RequestLike 无 ip 字段；trusted-headers 请求只要带齐 header 即放行并 upsert。
    setMode("trusted-headers");
    const headers = new Headers();
    headers.set("x-snow-user-id", "emp-77");
    headers.set("x-snow-user-email", "c@example.com");
    headers.set("x-snow-user-name", "User C");

    const u = await getCurrentUserFromRequest({ headers });
    expect(u).toMatchObject({ externalId: "emp-77", email: "c@example.com", name: "User C" });

    const rows = await db.select().from(user).where(eq(user.externalId, "emp-77"));
    expect(rows).toHaveLength(1);
  });

  it("trusted-headers 模式：缺身份 header → AuthError missing_identity（401）", async () => {
    setMode("trusted-headers");
    const headers = new Headers();
    headers.set("x-snow-user-email", "c@example.com");
    await expect(getCurrentUserFromRequest({ headers })).rejects.toMatchObject({
      code: "missing_identity",
    });
  });
});
