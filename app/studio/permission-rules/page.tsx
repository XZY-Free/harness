import { StudioGatePage } from "@/components/studio/gate-page";
import { PermissionRulesEditor } from "@/components/studio/permission-rules-editor";
import { hasStudioAction } from "@/lib/identity/studio-access";
import { loadPolicySetAndRules } from "@/lib/permission/policy-queries";
import { requireStudioPagePermission } from "@/lib/studio/page-auth";

/**
 * Studio Permission Rules 页（关口02 02-6 · 冻结方案 §30 / §54-P3）。
 *
 * - policy.read 即可查看当前生效 Policy Revision 的规则（ruleKey 稳定身份）。
 * - policy.publish 时渲染可编辑表单；保存走 PUT /studio/api/permission-rules +
 *   If-Match/ETag（§33），发布一个全新 Policy Revision（绝不原地改 published rows，§30）。
 * - 正式决策值仅 allow/pause/block（§P3）。
 */
export const dynamic = "force-dynamic";

export default async function PermissionRulesPage() {
  const gate = await requireStudioPagePermission("policy.read");
  if (!gate.ok) return <StudioGatePage status={gate.status} message={gate.message} />;

  const canWrite = await hasStudioAction(gate.principal, "policy.publish");
  const loaded = await loadPolicySetAndRules(gate.principal.tenantId);

  return (
    <div>
      <h1 className="text-[22px] font-semibold text-[var(--fg)]">权限规则</h1>
      <p className="mt-1 text-[13px] text-[var(--fg-muted)]">
        管理 Tool 执行策略（allow / pause / block）。保存将发布一个新的 Policy Revision （ruleKey
        跨修订稳定，ETag/If-Match 乐观锁）。
        {canWrite ? "" : "只读展示。编辑需要 policy.publish 权限。"}
      </p>
      <div className="mt-4">
        <PermissionRulesEditor
          initialDefaultDecision={loaded.defaultDecision}
          initialRules={loaded.rules.map((row) => ({
            id: row.id,
            ruleKey: row.ruleKey,
            toolPattern: row.toolPattern,
            argMatcher: (row.argMatcherJson as Record<string, string> | null) ?? null,
            decision: row.decision,
            scope: row.scopeJson as { type: string; ref?: string },
            priority: row.priority,
            reason: row.reason,
          }))}
          initialVersionNo={loaded.set.versionNo}
          canWrite={canWrite}
          revisionNo={loaded.revision.revisionNo}
          publishedAt={loaded.revision.publishedAt?.toISOString() ?? null}
        />
      </div>
    </div>
  );
}
