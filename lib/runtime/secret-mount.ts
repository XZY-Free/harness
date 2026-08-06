import { mkdir, rm, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import {
 appendThreadEvent,
 createSecretMount,
 getSecretMount,
 listActiveSecretsByScope,
 revokeSecretMount,
 rotateSecretMount,
} from "@/lib/db/queries";
import type { SecretMount, SecretMountScope } from "@/lib/db/schema";
import { decrypt, encrypt, isMasterKeyConfigured } from "./secret-crypto";
import { clearThreadSecrets, registerSecretValues } from "./secret-redaction";

/**
 * Stage C：Secret mount 生命周期管理 + env 注入 + 脱敏注册。
 *
 * 生产级 secret 管理（plan §1/§7）：
 * - create：加密存储（AES-256-GCM）+ status=active
 * - rotate：新密文覆盖 + rotatedAt + 旧明文从内存清除
 * - revoke：status=revoked，停止注入
 * - resolveSecrets：解析 scope 内 active secrets → 解密 → env map（运行时内存）
 * - injectSecrets：合并 env（container --env-file / host exec env）
 * - 脱敏：resolveSecrets 时注册明文值到 redaction registry，供全链路扫描替换
 *
 * fail-closed（plan §7/§12）：
 * - master key 缺失 → 所有操作抛错，不明文存储/注入
 * - 解析失败 → 明确错误（不静默空值）
 */

/** resolveSecrets 返回的 env map。 */
export type SecretEnvMap = Record<string, string>;

/** 创建 secret（加密存储 + status=active）。 */
export async function createSecret(params: {
 threadId: string;
 name: string;
 scope: SecretMountScope;
 scopeRef?: string | null;
 value: string;
}): Promise<SecretMount> {
 if (!isMasterKeyConfigured()) {
 throw new Error(
 "[secret-mount] SECRET_MASTER_KEY 未配置——secretMount fail-closed（不明文存储）",
 );
 }
 const encrypted = encrypt(params.value);
 const mount = await createSecretMount({
 name: params.name,
 scope: params.scope,
 scopeRef: params.scopeRef ?? null,
 keyId: encrypted.keyId,
 ciphertext: encrypted.ciphertext,
 });
 return mount;
}

/** 轮换 secret（新密文覆盖 + rotatedAt + 旧明文清除）。 */
export async function rotateSecret(
 threadId: string,
 secretMountId: string,
 newValue: string,
): Promise<SecretMount> {
 if (!isMasterKeyConfigured()) {
 throw new Error(
 "[secret-mount] SECRET_MASTER_KEY 未配置——secretMount fail-closed（不明文存储）",
 );
 }
 const existing = await getSecretMount(secretMountId);
 if (!existing) throw new Error(`[secret-mount] secret ${secretMountId} 不存在`);
 if (existing.status === "revoked") {
 throw new Error(`[secret-mount] secret ${secretMountId} 已撤销，无法轮换`);
 }
 // 审计修复：校验 thread 所有权（原仅按 secretMountId 操作，不验证 threadId，
 // 若调用方能控制 secretMountId 可操作其他 thread 的 secret）。
 if (existing.scope === "thread" && existing.scopeRef && existing.scopeRef !== threadId) {
 throw new Error("[secret-mount] 无权操作其他 thread 的 secret");
 }

 const encrypted = encrypt(newValue);
 const updated = await rotateSecretMount(secretMountId, encrypted.ciphertext, encrypted.keyId);
 if (!updated) throw new Error(`[secret-mount] secret ${secretMountId} 轮换失败`);

 await appendThreadEvent(threadId, "secret.rotated", {
 secretMountId,
 name: existing.name,
 scope: existing.scope,
 });

 return updated;
}

/** 撤销 secret（status=revoked，停止注入）。 */
export async function revokeSecret(threadId: string, secretMountId: string): Promise<SecretMount> {
 const existing = await getSecretMount(secretMountId);
 if (!existing) throw new Error(`[secret-mount] secret ${secretMountId} 不存在`);
 // 审计修复：校验 thread 所有权（与 rotateSecret 对齐）。
 if (existing.scope === "thread" && existing.scopeRef && existing.scopeRef !== threadId) {
 throw new Error("[secret-mount] 无权操作其他 thread 的 secret");
 }

 const updated = await revokeSecretMount(secretMountId);
 if (!updated) throw new Error(`[secret-mount] secret ${secretMountId} 撤销失败`);

 await appendThreadEvent(threadId, "secret.revoked", {
 secretMountId,
 name: existing.name,
 scope: existing.scope,
 });

 return updated;
}

/**
 * 解析 scope 内 active secrets → 解密 → env map。
 *
 * 同时注册明文值到 redaction registry（供全链路脱敏）。
 * fail-closed：master key 缺失 → 抛错（不返回空 env，不静默跳过）。
 *
 * @param threadId 用于注册脱敏值（请求结束需 clearThreadSecrets）
 * @param scope secret scope（thread/project/skill/tool）
 * @param scopeRef scope 绑定 id
 * @returns env map（name → decrypted value）
 */
export async function resolveSecrets(
 threadId: string,
 scope: SecretMountScope,
 scopeRef: string | null,
): Promise<SecretEnvMap> {
 if (!isMasterKeyConfigured()) {
 // master key 缺失 → fail-closed，不返回空 env（可能漏注入关键 secret）
 throw new Error(
 "[secret-mount] SECRET_MASTER_KEY 未配置——secretMount fail-closed（不明文注入）",
 );
 }

 const mounts = await listActiveSecretsByScope(scope, scopeRef);
 if (mounts.length === 0) {
 // 无 secret → 清除旧值（轮换后旧值清除）
 clearThreadSecrets(threadId);
 return {};
 }

 const envMap: SecretEnvMap = {};
 const plaintextValues: string[] = [];

 for (const mount of mounts) {
 try {
 const plaintext = decrypt({ keyId: mount.keyId, ciphertext: mount.ciphertext });
 envMap[mount.name] = plaintext;
 plaintextValues.push(plaintext);
 } catch (error) {
 throw new Error(
 `[secret-mount] secret ${mount.name} 解密失败：${error instanceof Error ? error.message : String(error)}`,
 );
 }
 }

 // 注册明文值到脱敏 registry（供 ToolRun 输出 / 日志 / manifest 扫描替换）
 registerSecretValues(threadId, plaintextValues);

 return envMap;
}

/** 合并 env（secret env 覆盖已有同名 key）。 */
export function injectSecrets(
 baseEnv: Record<string, string>,
 secrets: SecretEnvMap,
): Record<string, string> {
 return { ...baseEnv, ...secrets };
}

/**
 * 将 secret env 写入临时 --env-file（container 模式用）。
 *
 * 安全措施（plan §7/§12）：
 * - 文件权限 0o600（仅 owner 可读）
 * - 用后删除（container 启动后 env 已在容器内，文件可删）
 * - 不写命令行（避免 ps/process 列表泄露）
 *
 * @returns 临时文件路径（调用方负责删除）
 */
export async function writeSecretEnvFile(
 secrets: SecretEnvMap,
 dir: string,
 threadId: string,
): Promise<string> {
 // 审计修复 M5：校验 threadId 格式，防止通过构造含 ".." 或 "/" 的 threadId 实现路径穿越。
 // threadId 应为 UUID 或纯字母数字+连字符格式。
 if (!/^[a-zA-Z0-9-]+$/.test(threadId)) {
 throw new Error(`非法 threadId（含不安全字符）：${threadId}`);
 }
 const filePath = join(dir, `.snow/runtime/${threadId}/secret-env-${Date.now()}.env`);
 await mkdir(dirname(filePath), { recursive: true });
 // 审计修复：对 secret 值做引号包裹 + 转义（原 `${k}=${v}` 裸写，
 // 含换行符/等号/空格的值会破坏 env 文件格式，攻击者可通过注入换行符覆盖后续变量）。
 const lines = Object.entries(secrets).map(([k, v]) => {
 // POSIX 单引号内只需转义单引号本身（' → '\''）
 const escaped = v.replace(/'/g, "'\\''");
 return `${k}='${escaped}'`;
 });
 await writeFile(filePath, lines.join("\n"), { mode: 0o600 });
 return filePath;
}

/** 删除临时 secret env 文件（用后删除）。 */
export async function cleanupSecretEnvFile(filePath: string): Promise<void> {
 try {
 await rm(filePath, { force: true });
 } catch {
 // best-effort：文件可能已不存在
 }
}
