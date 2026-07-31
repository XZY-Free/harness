import type { ThreadEvent } from "@/lib/db/schema";

/**
 * Phase 4-4 Stage D：thread 事件时间线（只读）。
 * 渲染 thread_events 序列（agent.* / tool.* / artifact.*），按 sequence 升序。
 */

function eventTone(type: string): string {
  if (
    type.startsWith("tool.failed") ||
    type === "agent.status_changed" ||
    type === "delivery.failed" ||
    type === "deployment.failed" ||
    type === "qa.check_failed"
  )
    return "text-[var(--danger)]";
  if (
    type.startsWith("tool.succeeded") ||
    type === "artifact.created" ||
    type === "delivery.succeeded" ||
    type === "deployment.succeeded" ||
    type === "deployment.rolled_back" ||
    type === "secret.rotated" ||
    type === "qa.check_passed"
  )
    return "text-[var(--ok)]";
  if (
    type.startsWith("tool") ||
    type.startsWith("git.") ||
    type.startsWith("deployment.") ||
    type.startsWith("secret.")
  )
    return "text-[var(--primary)]";
  return "text-[var(--fg-muted)]";
}

function payloadSummary(payload: unknown): string {
  if (typeof payload !== "object" || payload === null) return "";
  const p = payload as Record<string, unknown>;
  if (typeof p.reason === "string") return p.reason;
  if (typeof p.to === "string") return `→ ${p.to}`;
  if (typeof p.toolName === "string") return p.toolName;
  if (typeof p.error === "string") return p.error;
  // V3.7：交付 / checkpoint 轻量事件
  // delivery.succeeded（payload = deliverySummary，含 commitSha + branch）
  if (typeof p.commitSha === "string" && typeof p.branch === "string") {
    return `交付 ${p.branch}@${p.commitSha.slice(0, 7)}`;
  }
  // git.checkpoint_restored（payload 含 tag + restoredTo）
  if (typeof p.tag === "string" && typeof p.restoredTo === "string") {
    return `回滚到 ${p.tag}`;
  }
  // git.checkpoint_created / delivery.failed 由上方 reason 分支覆盖
  // V3.0：context snapshot 轻量事件，不展示完整 manifest JSON
  if (typeof p.snapshotId === "string") return "已记录上下文快照";
  // V3.3a：上下文压缩轻量事件——「上下文压缩(N→M tokens)」
  if (typeof p.beforeTokens === "number" && typeof p.afterTokens === "number") {
    return `上下文压缩(${p.beforeTokens}→${p.afterTokens} tokens)`;
  }
  // V3.3a：summary 创建轻量事件
  if (typeof p.summaryId === "string" && typeof p.type === "string") {
    return `生成摘要: ${p.type}`;
  }
  // V3.1：审批事件轻量展示（不展示完整 argFingerprint）
  if (typeof p.approvalId === "string" && typeof p.decision === "string") {
    const scope = typeof p.scope === "string" ? ` (${p.scope})` : "";
    return `审批 ${p.decision}${scope}`;
  }
  if (typeof p.approvalId === "string" && typeof p.toolName === "string") {
    return `等待审批: ${p.toolName}`;
  }
  // V3.3b：长期记忆轻量事件（memory.created / memory.revoked）
  if (typeof p.memoryId === "string" && typeof p.kind === "string") {
    return `记忆: ${p.kind}`;
  }
  if (typeof p.memoryId === "string") {
    return `记忆撤销${typeof p.reason === "string" ? `: ${p.reason}` : ""}`;
  }
  // V3.2：后台任务事件轻量展示
  if (typeof p.taskId === "string" && typeof p.kind === "string") {
    const reason = typeof p.reason === "string" ? ` (${p.reason})` : "";
    return `${p.kind}${reason}`;
  }
  if (typeof p.taskId === "string" && typeof p.reason === "string") {
    return p.reason;
  }
  // V3.4：外部资料与 MCP 轻量事件
  // external.fetched（payload 含 sourceUrl）
  if (typeof p.sourceUrl === "string" && typeof p.contentHash === "string") {
    try {
      const host = new URL(p.sourceUrl).host;
      return `外部资料: ${host}`;
    } catch {
      return `外部资料: ${p.sourceUrl.slice(0, 40)}`;
    }
  }
  // mcp.called（payload 含 server + tool + permissionKey）
  if (typeof p.server === "string" && typeof p.tool === "string") {
    const ok = p.ok === false ? "（失败）" : "";
    return `MCP: ${p.server}.${p.tool}${ok}`;
  }
  // mcp.listed（payload 含 server + toolCount）
  if (typeof p.server === "string" && typeof p.toolCount === "number") {
    return `MCP 列工具: ${p.server} (${p.toolCount})`;
  }
  // V3.5：子代理生命周期轻量事件
  // subagent.spawned（payload 含 runId + role + goal）
  if (typeof p.runId === "string" && typeof p.role === "string" && typeof p.goal === "string") {
    return `子代理: ${p.role}`;
  }
  // subagent.joined（payload 含 runId + status + resultSummary?）
  if (
    typeof p.runId === "string" &&
    typeof p.status === "string" &&
    typeof p.resultSummary === "string"
  ) {
    return `子代理完成: ${p.status}`;
  }
  // subagent.failed（payload 含 runId + errorMessage?）
  if (typeof p.runId === "string" && typeof p.errorMessage === "string") {
    return `子代理失败: ${p.errorMessage.slice(0, 40)}`;
  }
  // V3.6：QA gate 事件轻量展示
  // qa.check_passed / qa.check_failed（payload 含 checkId + kind + failures?）
  if (typeof p.checkId === "string" && typeof p.kind === "string") {
    const kindLabel: Record<string, string> = {
      gate: "Gate",
      browser: "浏览器",
      responsive: "响应式",
      a11y: "a11y",
      verdict: "视觉评审",
    };
    const label = kindLabel[p.kind] ?? p.kind;
    if (Array.isArray(p.failures) && p.failures.length > 0) {
      const types = p.failures.map((f: { type: string }) => f.type).join(",");
      return `QA 失败(${label}): ${types}`;
    }
    return `QA 通过(${label})`;
  }
  // V3.8：部署事件轻量展示
  // deployment.succeeded（payload 含 deploymentId + environment + cicdJobId? + imageTag?）
  if (
    typeof p.deploymentId === "string" &&
    typeof p.environment === "string" &&
    p.action !== "rollback"
  ) {
    const image = typeof p.imageTag === "string" ? ` (${p.imageTag})` : "";
    return `部署到 ${p.environment}${image}`;
  }
  // deployment.failed（payload 含 deploymentId + errorMessage）
  if (
    typeof p.deploymentId === "string" &&
    typeof p.errorMessage === "string" &&
    p.environment === undefined
  ) {
    return `部署失败: ${p.errorMessage.slice(0, 60)}`;
  }
  // deployment.rolled_back（payload 含 deploymentId + previousDeploymentId）
  if (typeof p.deploymentId === "string" && typeof p.previousDeploymentId === "string") {
    return `回滚部署 ${p.previousDeploymentId.slice(0, 8)}`;
  }
  // V3.8：secret 事件轻量展示
  // secret.rotated（payload 含 secretMountId + name + scope）
  if (
    typeof p.secretMountId === "string" &&
    typeof p.name === "string" &&
    typeof p.scope === "string"
  ) {
    return `Secret 轮换: ${p.name} (${p.scope})`;
  }
  // secret.revoked（payload 含 secretMountId + name）
  if (typeof p.secretMountId === "string" && typeof p.name === "string") {
    return `Secret 撤销: ${p.name}`;
  }
  return "";
}

export function ThreadTimeline({ events }: { events: ThreadEvent[] }) {
  if (events.length === 0) {
    return <div className="text-[13px] text-[var(--fg-muted)]">无事件。</div>;
  }
  return (
    <ol className="flex flex-col gap-1.5">
      {events.map((e) => (
        <li
          key={e.id}
          className="flex items-start gap-3 rounded-[var(--radius-sm)] border border-[var(--border)] bg-[var(--surface)] px-3 py-2 text-[13px]"
        >
          <span className="w-6 shrink-0 text-[var(--fg-subtle)]">#{e.sequence}</span>
          <span className={`w-44 shrink-0 font-medium ${eventTone(e.type)}`}>{e.type}</span>
          <span className="flex-1 text-[var(--fg-muted)]">{payloadSummary(e.payload) || "—"}</span>
          <span className="shrink-0 text-[12px] text-[var(--fg-subtle)]">
            {new Date(e.createdAt).toLocaleTimeString()}
          </span>
        </li>
      ))}
    </ol>
  );
}
