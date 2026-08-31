import { StudioGatePage } from "@/components/studio/gate-page";
import { GovernanceEditor } from "@/components/studio/governance-editor";
import { StudioPage } from "@/components/studio/studio-page";
import { loadGovernanceConfigFromDB } from "@/lib/governance/governance-repository";
import { hasStudioAction } from "@/lib/identity/studio-access";
import { requireStudioPagePermission } from "@/lib/studio/page-auth";

/**
 * Studio Governance 配置页（关口02 02-6 · 冻结方案 §29 / §54-P2）。
 *
 * - policy.read 即可查看当前生效 Governance 配置（fail-closed 读取，绝不回退默认值）。
 * - governance.config.publish 时渲染可编辑表单；保存走 PUT + If-Match/ETag（§33）。
 * server component 取 DB current published config + 判定写权限，传给 client。
 */
export const dynamic = "force-dynamic";

export default async function GovernancePage() {
  const gate = await requireStudioPagePermission("policy.read");
  if (!gate.ok) return <StudioGatePage status={gate.status} message={gate.message} />;

  const canWrite = await hasStudioAction(gate.principal, "governance.config.publish");
  const loaded = await loadGovernanceConfigFromDB(gate.principal.tenantId);

  return (
    <StudioPage
      title="运行保护"
      description={
        canWrite
          ? "设置受保护路径、受限命令、写入格式化和交付前检查。保存后立即应用新配置。"
          : "查看当前运行保护配置。你没有修改权限。"
      }
    >
      <section aria-label="保护规则" className="space-y-3">
        <h2 className="px-0.5 text-sm font-semibold text-foreground">保护规则</h2>
        <GovernanceEditor
          initialConfig={loaded.config}
          initialVersionNo={loaded.set.versionNo}
          canWrite={canWrite}
          revisionNo={loaded.revision.revisionNo}
          publishedAt={loaded.revision.publishedAt?.toISOString() ?? null}
        />
      </section>
    </StudioPage>
  );
}
