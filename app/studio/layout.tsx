import { StudioGatePage } from "@/components/studio/gate-page";
import { StudioNav } from "@/components/studio/nav";
import { StudioToastProvider } from "@/components/studio/toast-provider";
import { AuthenticationError, type Principal, resolvePrincipal } from "@/lib/identity/resolver";
import { hasStudioAction, resolveStudioPrincipal } from "@/lib/identity/studio-access";
import { computeStudioNavVisibility } from "@/lib/studio/nav-visibility";
import type { StudioNavVisibility } from "@/lib/studio/nav-visibility";
import { headers } from "next/headers";

/**
 * 统一管理后台 layout（S11-W01 重组）。
 *
 * server component，在渲染子页前：
 * 1. 校验 SSO 身份（AuthError → 401 页）。
 * 2. 校验旧 studio.access 权限（PERMISSIONS 体系）→ 403 页。
 * 3. 解析 Principal（admin audience）→ 计算 8 大菜单可见性。
 * 4. 通过 → 左侧 <StudioNav visibleItems={...} /> + 右侧子页。
 *
 * 安全边界：
 * - studio.access 仍是入口校验（PERMISSIONS 体系），Action Scope 校验由各 API 路由负责。
 * - 菜单可见性仅是 UX 层，隐藏菜单不能代替授权校验（方案 S11-W01）。
 * - dev 模式下 DEFAULT_USER_ID 全部可见（与 devOpen 行为一致）。
 * - Principal 解析失败 fail-open（旧 studio.access 通过即放行），菜单全部隐藏。
 *
 * /studio/api/* 路由不经过本 layout（API 不走渲染），各自 requirePermission / requireActionScope 守卫。
 */
export const dynamic = "force-dynamic";

export default async function StudioLayout({
  children,
}: {
  children: React.ReactNode;
}) {
  let principal: Principal | undefined;
  try {
    principal = await resolveStudioPrincipal(await headers());
  } catch (error) {
    if (error instanceof AuthenticationError) {
      return <StudioGatePage status={401} message="当前身份无法进入管理后台" fullScreen />;
    }
    throw error;
  }

  // resolveStudioPrincipal 抛错已在 try/catch 内处理（401/重抛），此处 undefined 逻辑不可达。
  if (!principal) {
    throw new Error("studio layout: resolveStudioPrincipal 返回了空 principal");
  }
  const allowed = await hasStudioAction(principal, "studio.access");
  if (!allowed) {
    return <StudioGatePage status={403} message="当前账号没有后台访问权限" fullScreen />;
  }

  // S11-W01：解析 Principal 并计算 8 大菜单可见性。
  // 解析失败 fail-open：保留 studio.access 入口校验，但菜单全部隐藏。
  let visibility: StudioNavVisibility = {
    agents: false,
    capabilities: false,
    conversations: false,
    runtime: false,
    observability: false,
    security: false,
    operations: false,
    settings: false,
  };
  try {
    const h = await headers();
    const principal = await resolvePrincipal(h, "admin");
    visibility = await computeStudioNavVisibility(principal);
  } catch {
    // dev 模式或身份解析失败：保留 studio.access 入口校验，菜单全部隐藏
    // 实际生产中此分支几乎不触发（trusted-headers 模式由网关注入）
  }

  return (
    <StudioToastProvider>
      <div className="flex h-dvh bg-background text-foreground">
        <StudioNav visibleItems={visibility} />
        <main className="min-w-0 flex-1 overflow-y-auto px-5 pt-16 pb-10 md:px-10 md:py-10 lg:px-12">
          {children}
        </main>
      </div>
    </StudioToastProvider>
  );
}
