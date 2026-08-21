import { StudioGatePage } from "@/components/studio/gate-page";
import { PermissionRuleManager } from "@/components/studio/permission-rule-manager";
import { PolicyEditor } from "@/components/studio/policy-editor";
import { PolicyViewer } from "@/components/studio/policy-viewer";
import { getPolicyConfigRows } from "@/lib/db/studio-queries";
import { hasStudioAction } from "@/lib/identity/studio-access";
import { requireStudioPagePermission } from "@/lib/studio/page-auth";

/**
 * Agent Studio Policies 页（Phase 4-4 切片 B3）。
 *
 * - policy.read 即可只读查看（PolicyViewer）。
 * - 另有 policy.write 时渲染 PolicyEditor，可整配置保存。
 * - S1（07-P2-5）：PermissionRuleManager 管理 ask/deny/allow 持久化规则 + 变更审计。
 * server component 取 DB policy 行 + 判定 policy.write，传给 client。
 */
export const dynamic = "force-dynamic";

export default async function PoliciesPage() {
  const gate = await requireStudioPagePermission("policy.read");
  if (!gate.ok) return <StudioGatePage status={gate.status} message={gate.message} />;

  const canWrite = await hasStudioAction(gate.principal, "policy.write");
  const rows = await getPolicyConfigRows();

  return (
    <div>
      <h1 className="text-[22px] font-semibold text-[var(--fg)]">策略</h1>
      <p className="mt-1 text-[13px] text-[var(--fg-muted)]">
        {canWrite
          ? "查看并编辑当前 policy 配置（DB 化）。保存为整配置提交,服务端校验正则/形状/超时。"
          : "只读展示当前 policy 配置（DB 化）。编辑需要 policy.write 权限。"}
      </p>
      <div className="mt-4">
        {canWrite ? <PolicyEditor rows={rows} /> : <PolicyViewer rows={rows} />}
      </div>
      <PermissionRuleManager canWrite={canWrite} />
    </div>
  );
}
