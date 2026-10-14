"use client";

import { useApiData } from "@/components/hooks/use-api-data";
import { StudioGatePage } from "@/components/studio/gate-page";
import { GovernanceEditor } from "@/components/studio/governance-editor";
import { StudioPage } from "@/components/studio/studio-page";
import { useStudioContext } from "@/components/studio/studio-shell";
import { snapshotAllowsTenantAction } from "@/lib/client/studio-permissions";

/** /studio/api/governance GET 响应（wire 形状，与编辑器 props 对齐）。 */
interface GovernanceWire {
  set: { versionNo: number };
  config: {
    protectedPaths: string[];
    commandDenyList: string[];
    formatOnWrite: boolean;
    verifyBeforeDelivery: boolean;
    harnessLoopLimits?: {
      maxLoopSteps?: number;
      maxAgentCalls?: number;
      maxToolCalls?: number;
      maxKnowledgeSearches?: number;
      maxConsecutiveSameAction?: number;
    };
  };
  revision: { revisionNo: number; publishedAt: string | null };
}

/**
 * Studio Governance 配置页（关口02 02-6 · 冻结方案 §29 / §54-P2 · 页面数据 API 化）。
 *
 * - policy.read 即可查看当前生效 Governance 配置（接口 fail-closed，绝不回退默认值；403 → 门禁页）。
 * - governance.config.publish 时渲染可编辑表单（快照轻量断言）；保存走 PUT + If-Match/ETag（§33）。
 * - server component 直读已移除：数据来自 GET /studio/api/governance。
 */
export default function GovernancePage() {
  const { snapshot } = useStudioContext();
  const canWrite = snapshotAllowsTenantAction(snapshot, "governance.config.publish");
  const { data, loading, httpStatus, errorMessage } =
    useApiData<GovernanceWire>("/studio/api/governance");

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
          <GovernanceEditor
            initialConfig={data.config}
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
