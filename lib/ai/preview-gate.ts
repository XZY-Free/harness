import { apiPath } from "@/lib/api-fetch";
import type { RuntimeType } from "@/lib/config";
import {
 appendThreadEvent,
 getThreadById,
 updateThreadPreviewUrl,
 updateThreadStatus,
} from "@/lib/db/queries";
import type { ThreadStatus } from "@/lib/db/schema";
import { runVerifyBeforeDelivery } from "@/lib/policy/hooks";
import { runQaGate } from "@/lib/qa/gate";
import { stopAllByThread as stopAllBackgroundTasks } from "@/lib/runtime/background-task-registry";
import { probePreviewUrl } from "@/lib/runtime/preview-probe";
import { resolveRuntimes } from "@/lib/runtime/registry";
import { stopAllSubagents } from "@/lib/subagent/registry";
import { listWorkspaceFiles } from "@/lib/workspace";

// probePreviewUrl 抽到 lib/runtime/preview-probe.ts(,避免 DevServerPreviewRuntime 循环 import)
export { probePreviewUrl };

type DataArtifact = {
 previewUrl: string;
 status: ThreadStatus;
};

export type ReportReadyResult =
 | {
 ok: true;
 url: string;
 summary: string;
 }
 | {
 ok: false;
 error: string;
 summary: string;
 };

function hasIndexFile(files: string[]): boolean {
 return files.some((file) => file === "index.html" || file.endsWith("/index.html"));
}

export async function reportThreadReady(
 threadId: string,
 summary: string,
 runtimeType?: RuntimeType,
): Promise<ReportReadyResult> {
 // beforeDelivery（）：交付前必跑验证。未过 → fail-closed 拒绝交付，
 // 与探活失败同语义（previewUrl=null、status=executing、不开预览，回灌 agent 继续修）。
 // 验证基础设施不可用时同样 fail-closed，避免把“没验证成”伪装成“验证通过”。
 const verify = await runVerifyBeforeDelivery(threadId);
 if (!verify.allow) {
 const error = `交付前验证未过：${verify.reason}`;
 await Promise.all([
 updateThreadPreviewUrl(threadId, null),
 updateThreadStatus(threadId, "executing"),
 ]);
 return { ok: false, error, summary };
 }

 const preview = resolveRuntimes(threadId, runtimeType).preview;
 const { url, token, kind } = await preview.start(threadId);
 // 探活带静态预览 token（静态 server 现要求鉴权）
 const probe = await probePreviewUrl(url, { token });

 if (!probe.ok) {
 // 探活失败保持 previewUrl=null、status=executing；
 // 状态未变化（仍 executing），不追加空 status_changed 事件。
 await Promise.all([
 updateThreadPreviewUrl(threadId, null),
 updateThreadStatus(threadId, "executing"),
 ]);
 return { ok: false, error: probe.error, summary };
 }

 // Stage D：QA gate——probe 通过后、ready_for_review 前跑确定性浏览器质量门。
 // 默认启用（qaConfig.enabled=true）；本地开发可显式 QA_GATE_ENABLED=false 关闭。
 // 启用即 fail-closed：gate 失败（白屏/console error/404/浏览器不可用）与 verify/probe
 // 失败同语义——previewUrl=null、status=executing、回灌 agent。
 // gate 用 preview.start 返回的 localhost url（内部直达，Playwright host 侧可访问）。
 // 静态预览 server 要求 token 鉴权，QA gate 通过请求头带 token，避免 token 落 artifact。
 const gate = await runQaGate({
 threadId,
 previewUrl: url,
 previewToken: kind === "static" ? token : undefined,
 runtimeType,
 });
 if (!gate.ok) {
 await Promise.all([
 updateThreadPreviewUrl(threadId, null),
 updateThreadStatus(threadId, "executing"),
 ]);
 return { ok: false, error: gate.error ?? "QA gate 未过", summary };
 }

 // 探活通过——先追加事件 → 再投影更新
 // 静态页面显式指向 index.html。Next 会把尾斜杠 URL 重定向为无尾斜杠，若仍返回
 // /preview/{threadId}/，HTML 内 css/style.css 等相对路径会错误解析到 /preview/css/。
 // dev server 保留根路径，由其自身路由处理。
 const publicUrl = apiPath(
 kind === "static" ? `/preview/${threadId}/index.html` : `/preview/${threadId}/`,
 );
 await appendThreadEvent(threadId, "artifact.created", {
 type: "preview",
 status: "ready_for_review",
 previewUrl: publicUrl,
 });
 await appendThreadEvent(threadId, "agent.status_changed", {
 from: "executing",
 to: "ready_for_review",
 reason: "preview_ready",
 });
 await Promise.all([
 updateThreadPreviewUrl(threadId, publicUrl),
 updateThreadStatus(threadId, "ready_for_review"),
 ]);
 return { ok: true, url: publicUrl, summary };
}

export async function finalizeThreadRun(threadId: string): Promise<DataArtifact> {
 // thread 收尾时停止所有后台任务（best-effort，不阻塞 finalize；超时/失败不掩盖终态切换）
 await stopAllBackgroundTasks(threadId, "thread_end").catch(() => {});
 // thread 收尾时取消未完成子代理（running → cancelled），杜绝 orphan。
 // best-effort，不阻塞 finalize；状态机守护已 cancelled 的 run 不被后续完成态覆盖。
 await stopAllSubagents(threadId).catch(() => {});

 const thread = await getThreadById(threadId);
 // 已 ready_for_review 时，终态事件已在 reportThreadReady 落定，这里只复用投影。
 if (thread?.status === "ready_for_review" && thread.previewUrl) {
 return { previewUrl: thread.previewUrl, status: "ready_for_review" };
 }
 // 交付终态已由 gitPush/deliverySummary 落定，finalize 不再切 idle/failed，保留之。
 // completed = 已交付；delivering = 推送已成功、摘要待生成（transient，不应被收尾覆盖）。
 // cancelled = cancelRun 已标记取消，finalize 不应覆盖。
 if (
 thread?.status === "completed" ||
 thread?.status === "delivering" ||
 thread?.status === "cancelled"
 ) {
 return { previewUrl: thread.previewUrl ?? "", status: thread.status };
 }

 const files = await listWorkspaceFiles(threadId);
 const status: ThreadStatus = hasIndexFile(files) ? "failed" : "idle";
 const from = thread?.status ?? "executing";
 // 收尾切换状态：追加本轮最后一个 agent.status_changed，replay 据此判定最终态（）
 await appendThreadEvent(threadId, "agent.status_changed", {
 from,
 to: status,
 reason: status === "failed" ? "run_failed" : "run_idle",
 });
 // : CAS——仅当当前 status 仍为读取时的 from 才切换,防 cancel 并发把 cancelled 覆盖成 idle/failed
 await Promise.all([
 updateThreadPreviewUrl(threadId, null),
 updateThreadStatus(threadId, status, from),
 ]);
 return { previewUrl: "", status };
}
