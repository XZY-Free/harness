import { executeToolRun } from "@/lib/ai/tool-runtime";
import { deployConfig } from "@/lib/config";
import {
 appendThreadEvent,
 claimDeployingSlot,
 getDeployment,
 getLatestDeployedByThread,
 getThreadById,
 listDeploymentsByThread,
 updateDeployment,
} from "@/lib/db/queries";
import type { Deployment } from "@/lib/db/schema";
import { buildArtifact, persistArtifact, summarizeEnv } from "@/lib/deploy/artifact";
import {
 isCicdConfigured,
 queryStatus,
 triggerDeploy,
 triggerRollback,
} from "@/lib/deploy/cicd-target";
import { decryptCicdToken } from "@/lib/runtime/secret-crypto";
import { tool } from "ai";
import { z } from "zod";

/**
 * Stage D：部署工具（deployToEnvironment / deployStatus / rollback）。
 *
 * 生产级 CI/CD 交接（plan §8）：
 * - deployToEnvironment：默认 ask（prod 强制 ask），调 triggerDeploy，写 Deployment，
 * 返回 deploymentId + cicdJobUrl + artifact。
 * - deployStatus：默认 allow，查 queryStatus + DB 状态。
 * - rollback：默认 ask，查上一版 deployment → triggerRollback，写 deployment.rolled_back。
 *
 * 权限：deploy/rollback 默认 ask（delivery risk）；status 默认 allow。
 * prod 部署强制 ask（环境环境保护）。
 * CI/CD 未配置 → 明确错误（不静默失败）。
 */

/**
 * 构建部署工具集。
 *
 * @param threadId 当前 thread
 * @param commitSha finalizeThreadRun 的来源 commit（可空）
 */
export function buildDeployTools(threadId: string, commitSha?: string | null) {
 return {
 deployToEnvironment: tool({
 description:
 "经 CI/CD webhook 触发部署到指定环境（如 staging/prod）。默认需审批；prod 强制审批。" +
 "返回 deploymentId、CI/CD job 链接与部署 artifact。",
 inputSchema: z.object({
 environment: z
 .string()
 .describe("目标环境，如 staging 或 prod（必须在 DEPLOY_ENVIRONMENTS 列表内）"),
 imageTag: z.string().optional().describe("部署的 image tag（若 CI/CD 用 image 部署）"),
 }),
 execute: async ({ environment, imageTag }) => {
 return executeToolRun(
 threadId,
 "deployToEnvironment",
 // 审计修复：仅传入已定义字段，避免 imageTag:undefined 污染 argFingerprint
 // （stableStringify 序列化 undefined 导致 fingerprint 与审批请求不匹配）
 imageTag !== undefined ? { environment, imageTag } : { environment },
 async (signal) => {
 // 环境校验
 if (!deployConfig.environments.includes(environment)) {
 return {
 ok: false as const,
 error: `环境 "${environment}" 不在允许列表内（${deployConfig.environments.join(", ")}）`,
 };
 }

 // CI/CD 配置校验
 if (!isCicdConfigured()) {
 return {
 ok: false as const,
 error: "DEPLOY_CICD_WEBHOOK_URL 未配置——无法触发部署",
 };
 }

 // + : 原子占用 deploying 槽位——事务内 FOR UPDATE 锁 thread 行,
 // 查已有 deploying,无则 createDeployment。防 read-then-write 竞态触发多次 CI/CD。
 const claimed = await claimDeployingSlot({
 threadId,
 environment,
 commitSha: commitSha ?? null,
 imageTag: imageTag ?? null,
 });
 if ("busy" in claimed) {
 return {
 ok: false,
 error: `同 thread 已有部署正在进行中,请等待完成或取消后再部署`,
 };
 }
 const deployment = claimed.deployment;

 try {
 // P0-1: claim 已 insert deploying,无需再 updateDeployment 切状态(原两步法引入并发竞态)
 // : 读取并解密 per-thread CI/CD token（兼容明文）
 const thread = await getThreadById(threadId);
 const threadCicdToken = decryptCicdToken(thread?.cicdApiToken) ?? undefined;

 // 触发 CI/CD webhook
 const cicdResponse = await triggerDeploy({
 environment,
 commitSha: commitSha ?? undefined,
 imageTag: imageTag ?? undefined,
 artifactRef: deployment.id,
 threadCicdToken,
 });

 // 更新状态 → deploying（CI/CD 已接收，真实结果需后续轮询/查询）
 const updated = await updateDeployment(deployment.id, {
 status: "deploying",
 cicdJobId: cicdResponse.cicdJobId,
 cicdJobUrl: cicdResponse.cicdJobUrl ?? null,
 artifactRef: deployment.id,
 });

 if (!updated) {
 return { ok: false as const, error: "部署记录更新失败" };
 }

 // 构造 + 持久化 artifact
 const envSummary = summarizeEnv(process.env as Record<string, string>, threadId);
 const artifact = buildArtifact(updated, envSummary);
 const artifactPath = await persistArtifact(artifact, process.cwd());

 // 追加 deploying 事件（成功/失败事件在 deployStatus 确认真实状态后补发）
 await appendThreadEvent(threadId, "deployment.deploying", {
 deploymentId: deployment.id,
 environment,
 cicdJobId: cicdResponse.cicdJobId,
 imageTag: imageTag ?? null,
 });

 return {
 ok: true as const,
 deploymentId: deployment.id,
 environment,
 cicdJobId: cicdResponse.cicdJobId,
 cicdJobUrl: cicdResponse.cicdJobUrl,
 artifactPath,
 };
 } catch (error) {
 const errorMessage = error instanceof Error ? error.message : String(error);
 // 更新状态 → failed
 await updateDeployment(deployment.id, {
 status: "failed",
 errorMessage: errorMessage.slice(0, 500),
 });
 await appendThreadEvent(threadId, "deployment.failed", {
 deploymentId: deployment.id,
 errorMessage: errorMessage.slice(0, 200),
 });
 return { ok: false as const, error: errorMessage };
 }
 },
 );
 },
 }),

 deployStatus: tool({
 description: "查询部署状态与 CI/CD job 链接。可按 deploymentId 查询，不传则返回最近部署。",
 inputSchema: z.object({
 deploymentId: z.string().optional().describe("部署记录 id（不传则查询最近一次部署）"),
 }),
 execute: async ({ deploymentId }) => {
 return executeToolRun(
 threadId,
 "deployStatus",
 { deploymentId },
 async (signal) => {
 let deployment: Deployment | null;
 if (deploymentId) {
 deployment = await getDeployment(deploymentId);
 } else {
 const deployments = await listDeploymentsByThread(threadId);
 deployment = deployments[0] ?? null;
 }

 if (!deployment) {
 return { ok: false as const, error: "未找到部署记录" };
 }

 // 仅对进行中的部署查询 CI/CD 实时状态并回写 DB；查询失败要诚实暴露，
 // 不能静默伪装成"状态正常"。
 let cicdStatus: string | undefined;
 let cicdStatusMessage: string | undefined;
 if (deployment.cicdJobId && deployment.status === "deploying") {
 try {
 // : 传入解密后的 per-thread token 给 queryStatus
 const statusThread = await getThreadById(threadId);
 const statusToken = decryptCicdToken(statusThread?.cicdApiToken) ?? undefined;
 const status = await queryStatus(deployment.cicdJobId, statusToken);
 cicdStatus = status.status;
 cicdStatusMessage = status.message;

 if (cicdStatus === "succeeded") {
 const deployedAt = new Date();
 const updated = await updateDeployment(deployment.id, {
 status: "deployed",
 deployedAt,
 });
 deployment = updated ?? deployment;
 await appendThreadEvent(threadId, "deployment.succeeded", {
 deploymentId: deployment.id,
 environment: deployment.environment,
 cicdJobId: deployment.cicdJobId,
 imageTag: deployment.imageTag ?? null,
 });
 } else if (
 cicdStatus === "failed" ||
 cicdStatus === "error" ||
 cicdStatus === "cancelled"
 ) {
 const errorMessage = (cicdStatusMessage ?? `CI/CD ${cicdStatus}`).slice(0, 500);
 const updated = await updateDeployment(deployment.id, {
 status: "failed",
 errorMessage,
 });
 deployment = updated ?? deployment;
 await appendThreadEvent(threadId, "deployment.failed", {
 deploymentId: deployment.id,
 errorMessage: errorMessage.slice(0, 200),
 });
 }
 } catch (error) {
 const errorMessage = error instanceof Error ? error.message : String(error);
 return {
 ok: false as const,
 error: `CI/CD 状态查询失败：${errorMessage}`,
 deploymentId: deployment.id,
 environment: deployment.environment,
 status: deployment.status,
 cicdJobUrl: deployment.cicdJobUrl,
 };
 }
 }

 return {
 ok: true as const,
 deploymentId: deployment.id,
 environment: deployment.environment,
 status: deployment.status,
 cicdStatus,
 cicdJobUrl: deployment.cicdJobUrl,
 deployedAt: deployment.deployedAt?.toISOString(),
 errorMessage: deployment.errorMessage,
 };
 },
 // deployStatus 默认 allow（只读查询）
 { permissionKey: "tool.deployStatus" },
 );
 },
 }),

 rollback: tool({
 description: "经 CI/CD webhook 回滚到上一版部署。默认需审批。返回新 deploymentId。",
 inputSchema: z.object({
 deploymentId: z
 .string()
 .optional()
 .describe("要回滚的部署记录 id（不传则回滚最近一次成功部署）"),
 }),
 execute: async ({ deploymentId }) => {
 return executeToolRun(
 threadId,
 "rollback",
 // 审计修复：仅传入已定义字段，避免 deploymentId:undefined 污染 argFingerprint
 deploymentId !== undefined ? { deploymentId } : {},
 async () => {
 // 找到要回滚的部署
 let targetDeployment: Deployment | null;
 if (deploymentId) {
 targetDeployment = await getDeployment(deploymentId);
 } else {
 targetDeployment = await getLatestDeployedByThread(threadId);
 }

 if (!targetDeployment) {
 return { ok: false as const, error: "未找到可回滚的部署记录" };
 }

 // CI/CD 配置校验
 if (!isCicdConfigured()) {
 return {
 ok: false as const,
 error: "DEPLOY_CICD_WEBHOOK_URL 未配置——无法触发回滚",
 };
 }

 // : 回滚也原子占用 deploying 槽位,防并发回滚/部署触发多次 CI/CD
 const rollbackClaimed = await claimDeployingSlot({
 threadId,
 environment: targetDeployment.environment,
 commitSha: targetDeployment.commitSha,
 imageTag: targetDeployment.imageTag,
 previousDeploymentId: targetDeployment.id,
 });
 if ("busy" in rollbackClaimed) {
 return {
 ok: false as const,
 error: "同 thread 已有部署正在进行中,请等待完成或取消后再回滚",
 };
 }
 const rollbackDeployment = rollbackClaimed.deployment;

 try {
 // P0-1: claim 已 insert deploying,无需再 updateDeployment 切状态
 // : 回滚也用 per-thread token(与部署一致),不能回退全局 token
 const rollbackThread = await getThreadById(threadId);
 const rollbackToken = decryptCicdToken(rollbackThread?.cicdApiToken) ?? undefined;

 // 触发 CI/CD 回滚
 const cicdResponse = await triggerRollback({
 environment: targetDeployment.environment,
 previousDeploymentId: targetDeployment.id,
 previousCommitSha: targetDeployment.commitSha ?? undefined,
 previousImageTag: targetDeployment.imageTag ?? undefined,
 threadCicdToken: rollbackToken,
 });

 const updated = await updateDeployment(rollbackDeployment.id, {
 status: "deploying",
 cicdJobId: cicdResponse.cicdJobId,
 cicdJobUrl: cicdResponse.cicdJobUrl ?? null,
 });

 // 标记原部署为 rolled_back
 await updateDeployment(targetDeployment.id, {
 status: "rolled_back",
 rolledBackAt: new Date(),
 });

 // 构造 artifact
 if (updated) {
 const envSummary = summarizeEnv(process.env as Record<string, string>, threadId);
 const artifact = buildArtifact(updated, envSummary);
 await persistArtifact(artifact, process.cwd());
 }

 await appendThreadEvent(threadId, "deployment.rolled_back", {
 deploymentId: rollbackDeployment.id,
 previousDeploymentId: targetDeployment.id,
 });

 return {
 ok: true as const,
 deploymentId: rollbackDeployment.id,
 previousDeploymentId: targetDeployment.id,
 environment: targetDeployment.environment,
 cicdJobId: cicdResponse.cicdJobId,
 cicdJobUrl: cicdResponse.cicdJobUrl,
 };
 } catch (error) {
 const errorMessage = error instanceof Error ? error.message : String(error);
 await updateDeployment(rollbackDeployment.id, {
 status: "failed",
 errorMessage: errorMessage.slice(0, 500),
 });
 await appendThreadEvent(threadId, "deployment.failed", {
 deploymentId: rollbackDeployment.id,
 errorMessage: errorMessage.slice(0, 200),
 });
 return { ok: false as const, error: errorMessage };
 }
 },
 );
 },
 }),
 };
}
