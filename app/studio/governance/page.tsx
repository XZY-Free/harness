import { StudioGatePage } from "@/components/studio/gate-page";
import { GovernanceEditor } from "@/components/studio/governance-editor";
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
    <div>
      <h1 className="text-[22px] font-semibold text-[var(--fg)]">治理配置</h1>
      <p className="mt-1 text-[13px] text-[var(--fg-muted)]">
        管理 Runtime 执行的治理配置（受保护路径 / 命令黑名单 / 写前格式化 / 交付前校验）。
        {canWrite
          ? "保存将发布一个新的 published Revision（ETag/If-Match 乐观锁）。"
          : "只读展示。编辑需要 governance.config.publish 权限。"}
      </p>
      <div className="mt-4">
        <GovernanceEditor
          initialConfig={loaded.config}
          initialVersionNo={loaded.set.versionNo}
          canWrite={canWrite}
          revisionNo={loaded.revision.revisionNo}
          publishedAt={loaded.revision.publishedAt?.toISOString() ?? null}
        />
      </div>
    </div>
  );
}
