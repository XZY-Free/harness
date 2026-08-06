/**
 * 高风险 json 列的 zod 校验 schema。
 *
 * db 层 33 个 json 列此前写入前零校验，脏数据（非数组 / 缺字段 / 类型错）直接落库，
 * 后续读取时才报错（难追溯）。本模块为高风险 json 列定义 zod schema，写入函数入口校验，
 * 失败 fail-closed 抛错（不兜底、不静默写脏数据）。
 *
 * 覆盖列（按风险排序）：
 * - toolRun.input / output：工具入参 / 输出，结构化数据，脏数据破坏上下文压缩与审计
 * - customTool.inputSchema / executorConfig：自定义工具声明，脏数据导致工具注册失败
 * - contextSnapshot.layers / checksums：上下文清单，脏数据破坏压缩复用判定
 * - thread.pinnedFacts：protected 集合数据源，脏数据破坏注入
 * - memoryEntry.provenance：记忆溯源，脏数据导致孤儿记忆
 *
 * 设计：schema 宽松（record / unknown），只校验「必须是对象 / 数组 / 特定字段类型」，
 * 不校验业务语义（业务语义由调用方保证）。这样既挡住脏数据又不误伤合法变体。
 */
import { z } from "zod";

/** toolRun.input：工具入参，必须是对象（Record）。 */
export const toolRunInputSchema = z.record(z.string(), z.unknown());

/** toolRun.output：工具输出，必须是对象（Record）。 */
export const toolRunOutputSchema = z.record(z.string(), z.unknown());

/** customTool.inputSchema：JSON Schema 声明，必须是对象（至少有 type 字段）。 */
export const customToolInputSchemaSchema = z
 .object({
 type: z.string().optional(),
 })
 .passthrough();

/** customTool.executorConfig：executor 配置，必须是对象。webhook/script 各自字段由 registry 校验。 */
export const customToolExecutorConfigSchema = z.record(z.string(), z.unknown());

/** contextSnapshot.layers：context 层条目数组，每项是对象。 */
export const contextSnapshotLayersSchema = z.array(z.record(z.string(), z.unknown()));

/** contextSnapshot.checksums：稳定层 checksum map（key→hash 字符串）。 */
export const contextSnapshotChecksumsSchema = z.record(z.string(), z.string());

/**
 * V8：contextSnapshot.skillResolverInput — Resolver 输入摘要。
 * availableSkillCount + uiSelectedSkillIds（不含完整 SKILL.md）。
 */
export const contextSnapshotSkillResolverInputSchema = z
 .object({
 availableSkillCount: z.number().optional(),
 uiSelectedSkillIds: z.array(z.string()).optional(),
 })
 .passthrough();

/**
 * V8：contextSnapshot.skillResolverOutput — Resolver 输出摘要。
 * selectedSkillVersions（精简，仅 id/role/source）+ decisionReason + ignoredUiSelectedSkillIds。
 */
export const contextSnapshotSkillResolverOutputSchema = z
 .object({
 decisionReason: z.string().optional(),
 })
 .passthrough();

/**
 * V8：contextSnapshot.skillLoadEvidence — readSkillFile 加载证据数组。
 * 每项 { path, contentHash, truncated, skillVersionId, readAt }。
 */
export const contextSnapshotSkillLoadEvidenceSchema = z.array(z.record(z.string(), z.unknown()));

/** thread.pinnedFacts：用户 pinned facts，字符串数组（或 null=无）。 */
export const threadPinnedFactsSchema = z.array(z.string()).nullable();

/** memoryEntry.provenance：来源数组，每项 { kind, refId, threadId?, summary? }。 */
export const memoryProvenanceSchema = z
 .array(
 z.object({
 kind: z.enum(["tool_run", "message", "user"]),
 refId: z.string(),
 threadId: z.string().optional(),
 summary: z.string().optional(),
 }),
 )
 .min(1, "provenance 必须非空（防孤儿记忆）");

/**
 * 校验并通过返回原值（zod 通过即原值，不做转换）。
 * 失败抛 ZodError（调用方应让其向上传播，fail-closed）。
 * column 名仅用于错误消息上下文（zod 4 不再接受 path 选项）。
 */
export function validateJsonColumn<T>(value: unknown, schema: z.ZodType<T>, column: string): T {
 const result = schema.safeParse(value);
 if (!result.success) {
 // 包装错误消息，附上列名便于排查；保留 zod issue 结构
 const issue = result.error.issues[0];
 const msg = issue
 ? `[json-column:${column}] ${issue.message} (path=${JSON.stringify(issue.path)})`
 : `[json-column:${column}] 校验失败`;
 throw new Error(msg);
 }
 return result.data;
}
