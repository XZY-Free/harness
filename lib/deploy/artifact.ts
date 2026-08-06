import { mkdir, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import type { Deployment } from "@/lib/db/schema";
import { redactObject } from "@/lib/runtime/secret-redaction";

/**
 * Stage D：部署 artifact 构造与持久化。
 *
 * 部署 artifact 记录部署来源/配置/日志/回滚信息（plan §1/§8）：
 * - commit / image tag / artifact ref
 * - env 摘要（secret 脱敏）
 * - CI/CD job id + url + 状态
 * - 回滚信息（previousDeploymentId）
 *
 * 落 `.snow/runtime/{threadId}/deployments/{deployId}.json`，供审计与回滚追溯。
 */

/** 部署 artifact 结构。 */
export interface DeploymentArtifact {
 deploymentId: string;
 threadId: string;
 environment: string;
 commitSha?: string | null;
 imageTag?: string | null;
 artifactRef?: string | null;
 cicdJobId?: string | null;
 cicdJobUrl?: string | null;
 status: string;
 previousDeploymentId?: string | null;
 deployedAt?: string | null;
 rolledBackAt?: string | null;
 errorMessage?: string | null;
 createdAt: string;
 /** env 摘要（只记 key 名 + 值长度，不记值；secret 脱敏）。 */
 envSummary?: Record<string, string>;
}

/**
 * 从 Deployment 行 + 额外信息构造 artifact。
 *
 * @param deployment DB 部署记录
 * @param envSummary env 摘要（调用方负责脱敏：只记 key 名 + 值长度）
 */
export function buildArtifact(
 deployment: Deployment,
 envSummary?: Record<string, string>,
): DeploymentArtifact {
 return {
 deploymentId: deployment.id,
 threadId: deployment.threadId,
 environment: deployment.environment,
 commitSha: deployment.commitSha,
 imageTag: deployment.imageTag,
 artifactRef: deployment.artifactRef,
 cicdJobId: deployment.cicdJobId,
 cicdJobUrl: deployment.cicdJobUrl,
 status: deployment.status,
 previousDeploymentId: deployment.previousDeploymentId,
 deployedAt: deployment.deployedAt?.toISOString() ?? null,
 rolledBackAt: deployment.rolledBackAt?.toISOString() ?? null,
 errorMessage: deployment.errorMessage,
 createdAt: deployment.createdAt.toISOString(),
 envSummary,
 };
}

/**
 * 将 env 摘要脱敏（只记 key 名 + 值长度，不记值）。
 *
 * @param env 原始 env map
 * @param threadId 用于 secret 脱敏（按 thread 注册的 secret 值扫描替换）
 */
export function summarizeEnv(
 env: Record<string, string>,
 threadId: string,
): Record<string, string> {
 const summary: Record<string, string> = {};
 for (const [key, value] of Object.entries(env)) {
 // 先按 secret redaction 扫描替换，再记值长度
 const redacted = redactObject(value, threadId);
 summary[key] = `len=${String(redacted).length}`;
 }
 return summary;
}

/**
 * 持久化部署 artifact 到 `.snow/runtime/{threadId}/deployments/{deployId}.json`。
 */
export async function persistArtifact(
 artifact: DeploymentArtifact,
 baseDir: string,
): Promise<string> {
 const filePath = join(
 baseDir,
 ".snow/runtime",
 artifact.threadId,
 "deployments",
 `${artifact.deploymentId}.json`,
 );
 await mkdir(dirname(filePath), { recursive: true });
 await writeFile(filePath, JSON.stringify(artifact, null, 2), { mode: 0o600 });
 return filePath;
}
