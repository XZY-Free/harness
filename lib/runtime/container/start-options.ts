import { access } from "node:fs/promises";
import { type SecretEnvMap, cleanupSecretEnvFile, writeSecretEnvFile } from "../secret-mount";
import type { NetworkPolicy, ResourceQuota } from "../types";

type ContainerStartOptions = {
 quota?: ResourceQuota;
 networkPolicy?: NetworkPolicy;
 secretEnvFile?: string;
 /** 额外 docker run 参数（如 --add-host）。 */
 extraArgs?: string[];
};

/**
 * 统一准备 container 启动参数：
 * - secretResolver 失败直接抛错（fail-closed）
 * - 有 secret 时写临时 --env-file，调用方在 startContainer 之后清理
 *
 * secret env 文件缓存。
 * 原实现每次 exec 都重写 secret env 文件（ContainerExecutionRuntime.exec 每次 exec 都调本函数）。
 * 改为按 threadId + secrets hash 缓存文件路径：secrets 未变且文件存在 → 复用，跳过重写。
 * cleanup 改为 no-op（文件跨 exec 复用），由 `cleanupSecretFileCache(threadId)` 在容器停止时清理。
 */
const secretFileCache = new Map<string, { path: string; hash: string }>();

function hashSecrets(secrets: SecretEnvMap): string {
 // secrets 是小对象，JSON.stringify 作 hash 足够（键稳定排序）
 const keys = Object.keys(secrets).sort();
 return keys.map((k) => `${k}=${secrets[k] ?? ""}`).join("\n");
}

async function fileExists(path: string): Promise<boolean> {
 try {
 await access(path);
 return true;
 } catch {
 return false;
 }
}

export async function prepareContainerStartOptions(args: {
 threadId: string;
 quota?: ResourceQuota;
 networkPolicy?: NetworkPolicy;
 secretResolver?: () => Promise<SecretEnvMap>;
 existingSecrets?: SecretEnvMap;
 /** 额外 docker run 参数透传。 */
 extraArgs?: string[];
}): Promise<{
 startOptions: ContainerStartOptions;
 secretsCache?: SecretEnvMap;
 cleanup: () => Promise<void>;
}> {
 let secretsCache = args.existingSecrets;
 if (args.secretResolver && !secretsCache) {
 secretsCache = await args.secretResolver();
 }

 let secretEnvFile: string | undefined;
 if (secretsCache && Object.keys(secretsCache).length > 0) {
 const hash = hashSecrets(secretsCache);
 const cached = secretFileCache.get(args.threadId);
 if (cached && cached.hash === hash && (await fileExists(cached.path))) {
 // 缓存命中：secrets 未变 + 文件存在 → 复用，跳过重写
 secretEnvFile = cached.path;
 } else {
 // 缓存未命中：写新文件（覆盖旧缓存路径）+ 更新缓存
 if (cached) {
 await cleanupSecretEnvFile(cached.path).catch(() => {});
 }
 secretEnvFile = await writeSecretEnvFile(secretsCache, process.cwd(), args.threadId);
 secretFileCache.set(args.threadId, { path: secretEnvFile, hash });
 }
 }

 return {
 startOptions: {
 quota: args.quota,
 networkPolicy: args.networkPolicy,
 secretEnvFile,
 extraArgs: args.extraArgs,
 },
 secretsCache,
 // cleanup 改 no-op——文件跨 exec 复用，由 cleanupSecretFileCache 在容器停止时清理
 cleanup: async () => {},
 };
}

/**
 * 清理 thread 的缓存 secret env 文件（容器停止时调）。
 * 删除文件 + 清缓存。下次 start 会重新写入。
 */
export async function cleanupSecretFileCache(threadId: string): Promise<void> {
 const cached = secretFileCache.get(threadId);
 if (cached) {
 await cleanupSecretEnvFile(cached.path).catch(() => {});
 secretFileCache.delete(threadId);
 }
}

/** 仅供测试：清空 secret 文件缓存。 */
export function __clearSecretFileCacheForTest(): void {
 secretFileCache.clear();
}
