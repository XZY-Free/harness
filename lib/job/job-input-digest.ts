import { computeCanonicalDigest } from "@/lib/crypto/rfc-8785-canonicalize";

/**
 * Job 输入的**规范摘要**（A10）。
 *
 * 为什么必须规范化而不能直接 `JSON.stringify`：
 *
 * - `Job.inputJson` 落在 MySQL 的 JSON 列上。MySQL 会在写入时规范化 JSON（对象键按其规则
 *   排序、数字表示归一），因此**同一语义的对象经数据库 round-trip 后字节序会改变**；
 * - 原生 `JSON.stringify` 依赖属性插入顺序，于是 `{b,a}` 与 `{a,b}` 会得到不同摘要；
 * - 运行时复验（`runtime-resume.ts` 的 `jobInputDigest`）要求重算摘要与冻结的
 *   `Job.inputHash` / `Invocation.inputDigest` **全等**，键序一被数据库重排就会把
 *   **合法输入误判为篡改**（`InputDigestMismatch`）。
 *
 * 因此创建、重复接纳（`creationKey` 冲突比对）、运行时复验都必须共用这一条
 * RFC 8785（JCS）规范化摘要——它按 UTF-16 码元递归排序对象键、数组保序，是跨系统稳定的
 * JSON 表示。**不关闭完整性检查**：真正修改输入值仍然必须冲突。
 */
export function computeJobInputDigest(payload: unknown): string {
  return computeCanonicalDigest(payload ?? null);
}

/** 运行时复验所需的 Job 输入事实（只是一次真实回读的投影，不是新的事实源）。 */
export interface JobInputDigestFacts {
  inputKind: string;
  inputJson: unknown;
  inputRef: string | null;
  inputHash: string;
}

/**
 * 复算一个 Job 的当前输入摘要。
 *
 * - **inline**：payload 就在 `inputJson` 行内，按与 `createJob` 完全相同的规范算法重算
 *   ——这是真正能发现"行内输入被改写"的路径。
 * - **reference**：定位符本身不含内容。这里仅核对 Job 与 Invocation 的冻结摘要；
 *   创建、ContextHandle、Runtime 启动与 Hosted 读取还必须调用异步 Provider 读回内容复验。
 */
export function computeJobInputDigestForJob(job: JobInputDigestFacts): string {
  if (job.inputKind === "inline") return computeJobInputDigest(job.inputJson);
  return job.inputHash;
}

/** 摘要不一致时的稳定错误名（Runtime 协议错误码，见 runtime-protocol.ts）。 */
export const JOB_INPUT_DIGEST_MISMATCH = "InputDigestMismatch";

/**
 * 运行时复验：Job 的当前输入摘要必须同时等于冻结的 `inputHash` 与 `Invocation.inputDigest`。
 *
 * inline 的行内输入、Job 冻结摘要、Invocation 冻结摘要任一不等即拒绝执行。
 * reference 的真实内容必须另由 `resolveJobInputReference` 读取后核验。
 * 共享这条实现的目的：创建、重复接纳（creationKey 比对）与运行时复验必须是**同一个**
 * 规范化摘要，否则"合法输入经数据库 round-trip 被重排"会被误判为篡改（A10）。
 */
export function assertJobInputDigestMatches(input: {
  job: JobInputDigestFacts;
  invocationInputDigest: string | null;
}): string {
  const digest = computeJobInputDigestForJob(input.job);
  if (input.job.inputHash !== digest || digest !== input.invocationInputDigest) {
    throw new Error(JOB_INPUT_DIGEST_MISMATCH);
  }
  return digest;
}
