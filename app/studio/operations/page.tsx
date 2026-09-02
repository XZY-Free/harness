import { StudioGatePage } from "@/components/studio/gate-page";
import { RouteActivationPanel } from "@/components/studio/route-activation-panel";
import { StudioPage } from "@/components/studio/studio-page";
import {
  StudioSettingsRow,
  StudioSettingsSection,
} from "@/components/studio/studio-settings-section";
import { hasStudioAction } from "@/lib/identity/studio-access";
import { requireStudioPagePermission } from "@/lib/studio/page-auth";

/**
 * 统一管理后台 — 运营页。
 *
 * 一级导航「运营」展示使用量、成本、队列、配额、失败与服务水平。
 * 当前接入最小 Route 激活入口（07 §12）；S11-W07 将填充 cost/capacity 投影表 + 告警。
 *
 * 事实源：
 * - docs/architecture/runtime-control-plane.md
 *   「运营」：使用量、成本、队列、配额、失败与服务水平
 */
export const dynamic = "force-dynamic";

export default async function OperationsPage() {
  const gate = await requireStudioPagePermission("studio.access");
  if (!gate.ok) return <StudioGatePage status={gate.status} message={gate.message} />;

  const canManageRoutes = await hasStudioAction(gate.principal, "route.update");

  return (
    <StudioPage title="运营" description="管理员工侧智能体发布，并查看平台使用情况。" width="wide">
      <RouteActivationPanel canManage={canManageRoutes} />
      <StudioSettingsSection title="运营数据">
        <StudioSettingsRow title="成本与容量" description="用量、容量与异常提醒正在准备中。">
          <span className="rounded-full bg-muted px-2 py-1 text-xs text-muted-foreground">
            尚未开放
          </span>
        </StudioSettingsRow>
      </StudioSettingsSection>
    </StudioPage>
  );
}
