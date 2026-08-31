import { StudioGatePage } from "@/components/studio/gate-page";
import { RuntimeControlPanel } from "@/components/studio/runtime-control-panel";
import { StudioPage } from "@/components/studio/studio-page";
import {
  StudioSettingsLinkRow,
  StudioSettingsSection,
} from "@/components/studio/studio-settings-section";
import { hasStudioAction } from "@/lib/identity/studio-access";
import { requireStudioPagePermission } from "@/lib/studio/page-auth";

/**
 * 统一管理后台 — Runtime 治理页（07 §10/§11）。
 *
 * 替换 S11-W01 占位：接入 Runtime/RuntimeRevision 发布治理控制面板；
 * Route 操作按 07 §12 优先复用已有 DeploymentRoute/Activation UI，仅提供跳转。
 */
export const dynamic = "force-dynamic";

export default async function RuntimePage() {
  const gate = await requireStudioPagePermission("studio.access");
  if (!gate.ok) return <StudioGatePage status={gate.status} message={gate.message} />;

  const canPublish = await hasStudioAction(gate.principal, "runtime.publish");

  return (
    <StudioPage
      title="运行服务与环境"
      description="查看运行服务的版本、验收结果与发布状态。"
      width="wide"
    >
      <section aria-label="运行服务" className="space-y-3">
        <div className="space-y-1 px-0.5">
          <h2 className="text-sm font-semibold text-foreground">运行服务</h2>
          <p className="text-xs leading-5 text-muted-foreground">
            发布入口只会在所需验收已经通过时出现。
          </p>
        </div>
        <RuntimeControlPanel canPublish={canPublish} />
      </section>
      <StudioSettingsSection title="相关设置">
        <StudioSettingsLinkRow
          href="/studio/operations"
          title="员工侧发布"
          description="配置智能体的员工侧调用地址和访问方式。"
        />
      </StudioSettingsSection>
    </StudioPage>
  );
}
