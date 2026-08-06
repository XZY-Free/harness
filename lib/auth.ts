import { randomUUID } from "node:crypto";
import { authConfig } from "@/lib/config";
import { DEFAULT_USER_EMAIL, DEFAULT_USER_ID, DEFAULT_USER_NAME } from "@/lib/constants";
import { db } from "@/lib/db/client";
import { type User, user } from "@/lib/db/schema";
import { jsonError } from "@/lib/http";
import { eq } from "drizzle-orm";

/**
 * 用户主体解析（）。
 *
 * 取代单租户固定用户：dev 模式返回默认用户（兼容本地 / 测试），
 * trusted-headers 模式从公司网关 / SSO 代理注入的可信 header 解析身份并 upsert。
 * 不引入 OAuth / OIDC / SAML 依赖——真实 SSO 协议未知，先用可信 header 作接入边界。
 *
 * 安全边界：trusted-headers 模式下身份完全由 header 决定，应用层不做来源校验
 *（Next 16 route handler 无法获取 TCP 对端 IP）。必须靠网络隔离（K8s NetworkPolicy /
 * 防火墙）保证仅网关能达 pod，否则任意客户端可伪造 x-snow-user-* header 越权。
 *
 * User.id 继续用内部 UUID（保持 Thread.userId FK 稳定）；
 * User.externalId 存公司用户中心 subject / employee id，作 upsert 键。
 */

/** 认证失败错误。route 层应把 missing_identity / missing_email 映射为 401。 */
export class AuthError extends Error {
 constructor(
 public readonly code: "missing_identity" | "missing_email",
 message: string,
 ) {
 super(message);
 }
}

/**
 * 把 AuthError 转成 401 响应；非认证错误返回 null（交调用方处理 / 抛出）。
 * route 入口在 catch getCurrentUserFromRequest 时调用，避免认证失败被当 500。
 */
export function authErrorResponse(error: unknown): Response | null {
 if (error instanceof AuthError) {
 return jsonError(401, error.code, error.message);
 }
 return null;
}

/** 只需要能读 headers 的请求形态（兼容 Request / NextRequest）。 */
export type RequestLike = { headers: Headers };

type Identity = {
 externalId: string;
 email: string;
 name: string | null;
};

function headerValue(headers: Headers, name: string): string | null {
 const value = headers.get(name);
 return value?.trim() ? value.trim() : null;
}

/**
 * 从请求 header 解析用户身份。
 * - dev：返回默认用户身份。
 * - trusted-headers：读配置的 header；缺 externalId / email 抛 AuthError。
 */
export function resolveIdentityFromHeaders(headers: Headers): Identity {
 if (authConfig.mode === "dev") {
 return {
 externalId: DEFAULT_USER_ID,
 email: DEFAULT_USER_EMAIL,
 name: DEFAULT_USER_NAME,
 };
 }

 const externalId = headerValue(headers, authConfig.externalIdHeader);
 const email = headerValue(headers, authConfig.emailHeader);
 const name = headerValue(headers, authConfig.nameHeader);
 if (!externalId) {
 throw new AuthError("missing_identity", "缺少 SSO 用户标识");
 }
 if (!email) {
 throw new AuthError("missing_email", "缺少 SSO 用户邮箱");
 }
 return { externalId, email, name };
}

/**
 * 按 externalId upsert 用户。
 * - 命中：email/name 漂移则轻量 update，否则直接返回。
 * - 未命中：插入新 User（dev 默认用户复用 DEFAULT_USER_ID，其余用随机内部 id）。
 *
 * MySQL 无 PG 的 INSERT ... RETURNING：IGNORE 写入 + 回查，并发下也只建一行。
 */
export async function upsertUserByIdentity(identity: Identity): Promise<User> {
 const [existing] = await db
 .select()
 .from(user)
 .where(eq(user.externalId, identity.externalId))
 .limit(1);

 if (existing) {
 if (existing.email !== identity.email || existing.name !== identity.name) {
 await db
 .update(user)
 .set({ email: identity.email, name: identity.name })
 .where(eq(user.id, existing.id));
 return { ...existing, email: identity.email, name: identity.name };
 }
 return existing;
 }

 const row: User = {
 id: identity.externalId === DEFAULT_USER_ID ? DEFAULT_USER_ID : randomUUID(),
 externalId: identity.externalId,
 email: identity.email,
 name: identity.name,
 createdAt: new Date(),
 };
 await db.insert(user).ignore().values(row);
 const [created] = await db
 .select()
 .from(user)
 .where(eq(user.externalId, identity.externalId))
 .limit(1);
 if (!created) {
 throw new Error("无法创建或读取当前用户");
 }
 return created;
}

/** 从请求解析当前用户并 upsert（HTTP route 入口用）。 */
export async function getCurrentUserFromRequest(request: RequestLike): Promise<User> {
 return upsertUserByIdentity(resolveIdentityFromHeaders(request.headers));
}

/**
 * 无 Request 上下文时解析当前用户（仅 dev 模式可用；trusted-headers 模式下
 * 因无 header 会抛 AuthError，server component 应改用 getCurrentUserFromRequest）。
 */
export async function getCurrentUser(): Promise<User> {
 return upsertUserByIdentity(resolveIdentityFromHeaders(new Headers()));
}
