import { createHash, scrypt as nodeScrypt, randomBytes, timingSafeEqual } from "node:crypto";
import { db } from "@/lib/db/client";
import { seedDefaultGrants } from "@/lib/db/seed";
import type {
  AuthenticationLoginResult,
  AuthenticationResult,
  UserAuthenticationProvider,
} from "@/lib/identity/authentication-provider";
import { upsertPrincipalBinding } from "@/lib/identity/principal-binding-queries";
import { ensureDefaultTenant } from "@/lib/identity/tenant-queries";
import { upsertUserIdentity } from "@/lib/identity/user-identity-queries";
import { authSession, localCredential, userIdentity } from "@/lib/persistence/schema/identity";
import { and, eq, gt, isNull } from "drizzle-orm";

export const SESSION_COOKIE_NAME = "snow_session";

const SESSION_TTL_MS = 7 * 24 * 60 * 60 * 1_000;
const MAX_FAILED_LOGINS = 5;
const LOCK_DURATION_MS = 15 * 60 * 1_000;
const SCRYPT_KEY_LENGTH = 64;
const SCRYPT_N = 16_384;
const SCRYPT_R = 8;
const SCRYPT_P = 1;
const DUMMY_SALT = "snow-harness-missing-account-v1";

interface PasswordRecord {
  version: "scrypt-v1";
  n: number;
  r: number;
  p: number;
  salt: string;
  digest: string;
}

export interface BootstrapLocalAdminInput {
  readonly email: string;
  readonly displayName: string;
  readonly password: string;
}

export async function bootstrapLocalAdmin(input: BootstrapLocalAdminInput) {
  const normalizedEmail = normalizeEmail(input.email);
  const displayName = input.displayName.trim();
  if (!isValidEmail(normalizedEmail)) throw new Error("管理员邮箱格式不正确");
  if (!displayName) throw new Error("管理员名称不能为空");
  if (input.password.length < 12) throw new Error("管理员密码至少需要 12 个字符");

  const tenant = await ensureDefaultTenant();
  const identity = await upsertUserIdentity({
    tenantId: tenant.id,
    externalSubject: `local:${normalizedEmail}`,
    email: normalizedEmail,
    displayName,
  });
  const passwordHash = await hashPassword(input.password);
  const now = new Date();

  await db.transaction(async (tx) => {
    const [existing] = await tx
      .select({ id: localCredential.id })
      .from(localCredential)
      .where(
        and(
          eq(localCredential.tenantId, tenant.id),
          eq(localCredential.normalizedEmail, normalizedEmail),
        ),
      )
      .limit(1);

    if (existing) {
      await tx
        .update(localCredential)
        .set({
          userIdentityId: identity.id,
          passwordHash,
          failedLoginCount: 0,
          lockedUntil: null,
          passwordChangedAt: now,
          updatedAt: now,
        })
        .where(eq(localCredential.id, existing.id));
    } else {
      await tx.insert(localCredential).values({
        tenantId: tenant.id,
        userIdentityId: identity.id,
        normalizedEmail,
        passwordHash,
        passwordChangedAt: now,
        createdAt: now,
        updatedAt: now,
      });
    }

    await tx
      .update(authSession)
      .set({ revokedAt: now })
      .where(and(eq(authSession.userIdentityId, identity.id), isNull(authSession.revokedAt)));
  });

  const principal = await upsertPrincipalBinding({
    tenantId: tenant.id,
    subjectType: "user",
    externalId: identity.externalSubject,
    displayName: identity.displayName,
    userIdentityId: identity.id,
  });
  await seedDefaultGrants(tenant.id, principal.id);

  return identity;
}

export const localAuthenticationProvider: UserAuthenticationProvider = {
  name: "local-session",

  async authenticate({ headers }): Promise<AuthenticationResult> {
    const token = readCookie(headers, SESSION_COOKIE_NAME);
    if (!token) return { status: "unauthenticated" };

    const now = new Date();
    const [row] = await db
      .select({
        externalSubject: userIdentity.externalSubject,
        email: userIdentity.email,
        displayName: userIdentity.displayName,
        userStatus: userIdentity.status,
      })
      .from(authSession)
      .innerJoin(userIdentity, eq(userIdentity.id, authSession.userIdentityId))
      .where(
        and(
          eq(authSession.tokenHash, hashSessionToken(token)),
          isNull(authSession.revokedAt),
          gt(authSession.expiresAt, now),
        ),
      )
      .limit(1);

    if (!row) return { status: "unauthenticated" };
    if (row.userStatus !== "active") return { status: "denied", reason: "当前用户已停用" };
    return {
      status: "authenticated",
      evidence: {
        externalSubject: row.externalSubject,
        email: row.email,
        displayName: row.displayName,
        trustedAuthenticationClaims: {},
      },
    };
  },

  async login({ email, password }): Promise<AuthenticationLoginResult> {
    const normalizedEmail = normalizeEmail(email);
    const tenant = await ensureDefaultTenant();

    return db.transaction(async (tx) => {
      const [row] = await tx
        .select({
          credentialId: localCredential.id,
          passwordHash: localCredential.passwordHash,
          failedLoginCount: localCredential.failedLoginCount,
          lockedUntil: localCredential.lockedUntil,
          userIdentityId: userIdentity.id,
          userEmail: userIdentity.email,
          displayName: userIdentity.displayName,
          userStatus: userIdentity.status,
        })
        .from(localCredential)
        .innerJoin(userIdentity, eq(userIdentity.id, localCredential.userIdentityId))
        .where(
          and(
            eq(localCredential.tenantId, tenant.id),
            eq(localCredential.normalizedEmail, normalizedEmail),
          ),
        )
        .limit(1)
        .for("update");

      if (!row) {
        await verifyMissingAccountPassword(password);
        return { status: "denied" };
      }

      const passwordMatches = await verifyPassword(password, row.passwordHash);
      const now = new Date();
      if (row.lockedUntil && row.lockedUntil > now) {
        return {
          status: "rate_limited",
          retryAfterSeconds: Math.max(
            1,
            Math.ceil((row.lockedUntil.getTime() - now.getTime()) / 1_000),
          ),
        };
      }
      if (!passwordMatches || row.userStatus !== "active") {
        const failedLoginCount = row.failedLoginCount + 1;
        const lockedUntil =
          failedLoginCount >= MAX_FAILED_LOGINS ? new Date(now.getTime() + LOCK_DURATION_MS) : null;
        await tx
          .update(localCredential)
          .set({ failedLoginCount, lockedUntil, updatedAt: now })
          .where(eq(localCredential.id, row.credentialId));
        return lockedUntil
          ? {
              status: "rate_limited",
              retryAfterSeconds: Math.ceil(LOCK_DURATION_MS / 1_000),
            }
          : { status: "denied" };
      }

      const sessionToken = randomBytes(32).toString("base64url");
      const expiresAt = new Date(now.getTime() + SESSION_TTL_MS);
      await tx
        .update(localCredential)
        .set({ failedLoginCount: 0, lockedUntil: null, updatedAt: now })
        .where(eq(localCredential.id, row.credentialId));
      await tx.insert(authSession).values({
        tenantId: tenant.id,
        userIdentityId: row.userIdentityId,
        tokenHash: hashSessionToken(sessionToken),
        expiresAt,
        createdAt: now,
      });

      return {
        status: "authenticated",
        sessionToken,
        expiresAt,
        user: { email: row.userEmail, displayName: row.displayName },
      };
    });
  },

  async logout({ headers }): Promise<void> {
    const token = readCookie(headers, SESSION_COOKIE_NAME);
    if (!token) return;
    await db
      .update(authSession)
      .set({ revokedAt: new Date() })
      .where(
        and(eq(authSession.tokenHash, hashSessionToken(token)), isNull(authSession.revokedAt)),
      );
  },
};

export async function hashPassword(password: string): Promise<string> {
  const salt = randomBytes(16).toString("base64url");
  const digest = await derivePassword(password, salt, SCRYPT_N, SCRYPT_R, SCRYPT_P);
  return ["scrypt-v1", SCRYPT_N, SCRYPT_R, SCRYPT_P, salt, digest.toString("base64url")].join("$");
}

export async function verifyPassword(password: string, encoded: string): Promise<boolean> {
  const record = parsePasswordRecord(encoded);
  if (!record) return false;
  const actual = await derivePassword(password, record.salt, record.n, record.r, record.p);
  const expected = Buffer.from(record.digest, "base64url");
  return actual.length === expected.length && timingSafeEqual(actual, expected);
}

function normalizeEmail(email: string): string {
  return email.trim().toLowerCase();
}

function isValidEmail(email: string): boolean {
  return /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email) && email.length <= 254;
}

async function verifyMissingAccountPassword(password: string): Promise<void> {
  await derivePassword(password, DUMMY_SALT, SCRYPT_N, SCRYPT_R, SCRYPT_P);
}

async function derivePassword(
  password: string,
  salt: string,
  n: number,
  r: number,
  p: number,
): Promise<Buffer> {
  return new Promise((resolve, reject) => {
    nodeScrypt(
      password,
      salt,
      SCRYPT_KEY_LENGTH,
      { N: n, r, p, maxmem: 64 * 1024 * 1024 },
      (error, derivedKey) => {
        if (error) reject(error);
        else resolve(derivedKey);
      },
    );
  });
}

function parsePasswordRecord(encoded: string): PasswordRecord | null {
  const [version, n, r, p, salt, digest, ...rest] = encoded.split("$");
  if (
    rest.length > 0 ||
    version !== "scrypt-v1" ||
    !salt ||
    !digest ||
    !/^\d+$/.test(n ?? "") ||
    !/^\d+$/.test(r ?? "") ||
    !/^\d+$/.test(p ?? "") ||
    Number(n) !== SCRYPT_N ||
    Number(r) !== SCRYPT_R ||
    Number(p) !== SCRYPT_P
  ) {
    return null;
  }
  return {
    version,
    n: Number(n),
    r: Number(r),
    p: Number(p),
    salt,
    digest,
  };
}

function hashSessionToken(token: string): string {
  return createHash("sha256").update(token).digest("hex");
}

function readCookie(headers: Headers, name: string): string | null {
  const raw = headers.get("cookie");
  if (!raw) return null;
  for (const part of raw.split(";")) {
    const separator = part.indexOf("=");
    if (separator < 0) continue;
    if (part.slice(0, separator).trim() !== name) continue;
    const value = part.slice(separator + 1).trim();
    return value || null;
  }
  return null;
}
