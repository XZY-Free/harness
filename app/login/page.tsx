/**
 * 登录入口（302 壳）。
 *
 * nexharness 不再提供登录表单：统一登录由 auth-center 门户承载
 * （消费方模型，见 docs/split 施工图 v4）。
 *
 * 流程：
 * 1. 本页把 returnTo 拼成绝对地址（当前站点 origin + 路径）。
 * 2. 302 到 `{auth-center}/login?returnTo=<绝对地址>`。
 * 3. 用户完成登录后，auth-center 回跳 `<绝对地址>?ticket=...`；
 *    由 middleware.ts 兑换票据并落地会话 cookie。
 */
import { identityClientConfig } from "@/lib/identity-client";
import { headers } from "next/headers";
import { redirect } from "next/navigation";

export const dynamic = "force-dynamic";

export default async function LoginPage({
  searchParams,
}: {
  readonly searchParams: Promise<{ returnTo?: string | string[] }>;
}) {
  const returnTo = safeReturnTo((await searchParams).returnTo);
  const h = await headers();
  const protocol = h.get("x-forwarded-proto") ?? "http";
  const host = h.get("x-forwarded-host") ?? h.get("host") ?? "localhost:3000";
  const absolute = `${protocol}://${host}${returnTo}`;
  redirect(`${identityClientConfig.baseUrl}/login?returnTo=${encodeURIComponent(absolute)}`);
}

function safeReturnTo(value: string | string[] | undefined): string {
  if (typeof value !== "string") return "/chat";
  return value.startsWith("/") && !value.startsWith("//") && !value.includes("\\")
    ? value
    : "/chat";
}
