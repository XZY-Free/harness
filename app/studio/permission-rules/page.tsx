"use client";

import { useApiData } from "@/components/hooks/use-api-data";
import { StudioGatePage } from "@/components/studio/gate-page";
import { PermissionRulesEditor } from "@/components/studio/permission-rules-editor";
import { StudioPage } from "@/components/studio/studio-page";
import { useStudioContext } from "@/components/studio/studio-shell";
import { snapshotAllowsTenantAction } from "@/lib/client/studio-permissions";

/** /studio/api/permission-rules GET 响应（wire 形状）。 */
interface PermissionRulesWire {
  set: { versionNo: number };
  defaultDecision: "allow" | "pause" | "block";
  rules: Array<{
    id: string;
    ruleKey: string;
    toolPattern: string;
    argMatcher: unknown;
    decision: "allow" | "pause" | "block";
    scope: unknown;
    priority: number;
    reason: string | null;
  }>;
  revision: { revisionNo: number; publishedAt: string | null };
}

/**
 * Studio Permission Rules 页（关口02 02-6 · 冻结方案 §30 / §54-P3 · 页面数据 API 化）。
 *
 * - policy.read 即可查看当前生效 Policy Revision 的规则（ruleKey 稳定身份；403 → 门禁页）。
 * - policy.publish 时渲染可编辑表单（快照轻量断言）；保存走 PUT /studio/api/permission-rules +
 *   If-Match/ETag（§33），发布一个全新 Policy Revision（绝不原地改 published rows，§30）。
 * - 正式决策值仅 allow/pause/block（§P3）；数据来自 GET /studio/api/permission-rules。
 */
export default function PermissionRulesPage() {
  const { snapshot } = useStudioContext();
  const canWrite = snapshotAllowsTenantAction(snapshot, "policy.publish");
  const { data, loading, httpStatus, errorMessage } = useApiData<PermissionRulesWire>(
    "/studio/api/permission-rules",
  );

  return (
    <StudioPage
      title="工具权限"
      description={
        canWrite
          ? "设置工具执行时允许、等待确认或阻止的规则。保存后立即应用新策略。"
          : "查看当前工具权限规则。你没有修改权限。"
      }
      width="wide"
    >
      <section aria-label="权限规则" className="space-y-3">
        <h2 className="px-0.5 text-sm font-semibold text-foreground">权限规则</h2>
        {httpStatus !== null ? (
          <StudioGatePage
            status={httpStatus === 0 ? 500 : httpStatus}
            message={errorMessage ?? "加载失败，请稍后重试"}
          />
        ) : loading || !data ? (
          <div className="rounded-xl border border-border bg-card px-5 py-10 text-center text-sm text-muted-foreground">
            正在加载…
          </div>
        ) : (
          <PermissionRulesEditor
            initialDefaultDecision={data.defaultDecision}
            initialRules={data.rules.map((row) => ({
              id: row.id,
              ruleKey: row.ruleKey,
              toolPattern: row.toolPattern,
              argMatcher: (row.argMatcher as Record<string, string> | null) ?? null,
              decision: row.decision,
              scope: row.scope as { type: string; ref?: string },
              priority: row.priority,
              reason: row.reason,
            }))}
            initialVersionNo={data.set.versionNo}
            canWrite={canWrite}
            revisionNo={data.revision.revisionNo}
            publishedAt={data.revision.publishedAt}
          />
        )}
      </section>
    </StudioPage>
  );
}
