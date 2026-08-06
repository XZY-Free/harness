import {
 appendThreadEvent,
 createSubagentDefinition,
 createSubagentRun,
 getSubagentDefinition,
 getSubagentRun,
 listActiveSubagentRunsByThread,
 listSubagentDefinitions,
 listSubagentRunsByThread,
 updateSubagentRun,
} from "@/lib/db/queries";
import type {
 SubagentDefinition,
 SubagentRole,
 SubagentRun,
 SubagentRunStatus,
} from "@/lib/db/schema";
import { logger } from "@/lib/logger";

/**
 * Stage A：子代理 registry——SubagentDefinition/Run CRUD + 生命周期编排。
 *
 * 子代理执行模型（蓝图 ）：进程内嵌套 streamText 循环 + SubagentRun DB 行做审计/状态
 * + transcript 落 artifact。本模块只管数据层与生命周期约束（状态机 / writeScope 互斥 / 并发上限 /
 * outputSchema 校验），**不接执行**（的 executeSubagent 才跑 streamText）。
 *
 * 四个命门（计划执行规矩 §3）在此落地：
 * - writeScope 互斥：createRun 时检查同父 thread 活跃 run 的 writeScope，重叠则拒绝（fail-closed，§14）。
 * - 并发上限：同父 thread 活跃 run 数超上限（默认 5）则拒绝 spawn。
 * - transcript 不进父 Message 表：本模块只写 SubagentRun + thread 事件，绝不写 Message 表。
 * - 失败不崩父：状态机把异常收敛为 status=failed，不向上抛（由 runtime/join 处理）。
 */

/** 单父 thread 并发子代理软上限（蓝图 / 计划 §1 决策）。 */
export const DEFAULT_SUBAGENT_CONCURRENCY_CAP = 5;

/** 活跃态：queued 或 running（queued 也占写范围名额，fail-closed）。 */
const ACTIVE_STATUSES: SubagentRunStatus[] = ["queued", "running"];

/** 终态。 */
const TERMINAL_STATUSES: SubagentRunStatus[] = ["completed", "failed", "cancelled", "timed_out"];

/** 合法状态迁移。key=from，value=可迁往的 to 集合。 */
const TRANSITIONS: Record<SubagentRunStatus, SubagentRunStatus[]> = {
 queued: ["running", "cancelled"],
 running: ["completed", "failed", "cancelled", "timed_out"],
 completed: [],
 failed: [],
 cancelled: [],
 timed_out: [],
};

// ─── Definition CRUD ─────────────────────────────────────────

/**
 * 子代理定义不得包含「再 spawn」能力工具（嵌套深度=1，defense-in-depth 早期拒绝）。
 * 原实现只在运行时 stripSpawnTools 剥离，坏定义可落库；这里在 createDefinition 入口就拒绝。
 */
const FORBIDDEN_SUBAGENT_TOOLS = new Set(["spawnSubagent", "joinSubagent", "joinSubagents"]);

export async function createDefinition(params: {
 name: string;
 role: SubagentRole;
 modelProfileId?: string | null;
 allowedTools: string[];
 contextPolicy?: Record<string, unknown>;
 outputSchema?: Record<string, unknown> | null;
 defaultWriteScope?: string[] | null;
}): Promise<SubagentDefinition> {
 // 早期拒绝含 spawn 能力的定义（不依赖运行时剥离）
 const forbidden = params.allowedTools.filter((t) => FORBIDDEN_SUBAGENT_TOOLS.has(t));
 if (forbidden.length > 0) {
 throw new Error(`子代理定义不得包含 spawn 能力工具（嵌套深度=1）：${forbidden.join(", ")}`);
 }
 return createSubagentDefinition({
 name: params.name,
 role: params.role,
 modelProfileId: params.modelProfileId ?? null,
 allowedTools: params.allowedTools,
 contextPolicy: params.contextPolicy ?? {},
 outputSchema: params.outputSchema ?? null,
 defaultWriteScope: params.defaultWriteScope ?? null,
 });
}

export async function listDefinitions(): Promise<SubagentDefinition[]> {
 return listSubagentDefinitions();
}

export async function getDefinition(id: string): Promise<SubagentDefinition | null> {
 return getSubagentDefinition(id);
}

// ─── writeScope 互斥（§14）───────────────────────────────────
//
// 同父 thread 并发子代理的 writeScope 不得重叠。writeScope 是路径 glob 数组；null/空=只读，
// 只读之间、只读与写之间都不冲突。两个写 scope 重叠则拒绝 spawn。
//
// glob 重叠判定是保守启发式（fail-closed）：取每个 glob 第一个通配符之前的字面前缀做目录级
// 前缀比较；无通配符的 glob 视为精确路径；含 `**`/`*` 开头的 glob 前缀为空=匹配全部，与任何
// 非空写 scope 都视为重叠。这不追求 glob 语义完备，只求「可能冲突就拒绝」。

/**
 * 取 glob 的字面前缀（第一个通配符之前的部分），规范化掉前导 ./ / 和尾部 /。
 * 展开 brace `{a,b}` 为多个前缀取最宽（fail-closed：brace 视为多前缀，
 * 任一与对方重叠即拒绝）。仍不追求 picomatch 完备语义，只求「可能冲突就拒绝」。
 */
function globPrefixes(glob: string): string[] {
 // 先展开 brace：src/{a,b}/x → [src/a/x, src/b/x]
 const braceRe = /\{([^{}]+)\}/;
 const expand = (g: string): string[] => {
 const m = braceRe.exec(g);
 if (!m || m.index === undefined || m[1] === undefined) return [g];
 const opts = m[1].split(",");
 return opts.flatMap((o) => expand(g.slice(0, m.index) + o + g.slice(m.index + m[0].length)));
 };
 return expand(glob).map((g) => {
 const star = g.search(/[*?]/);
 const prefix = star === -1 ? g : g.slice(0, star);
 return prefix.replace(/^\.?\//, "").replace(/\/+$/, "");
 });
}

/** 两个写 scope 是否重叠（保守 fail-closed）。null/空 scope = 只读，不与任何 scope 重叠。 */
export function writeScopesOverlap(a: string[] | null, b: string[] | null): boolean {
 const aa = (a ?? []).filter((g) => g.length > 0);
 const bb = (b ?? []).filter((g) => g.length > 0);
 if (aa.length === 0 || bb.length === 0) return false;
 const pa = aa.flatMap(globPrefixes);
 const pb = bb.flatMap(globPrefixes);
 for (const x of pa) {
 for (const y of pb) {
 // 任一为空前缀（unbounded glob，匹配全部）→ 与任何写 scope 重叠
 if (x === "" || y === "") return true;
 // 目录级前缀包含：x 是 y 的祖先路径（或相等）
 if (x === y || x.startsWith(`${y}/`) || y.startsWith(`${x}/`)) return true;
 }
 }
 return false;
}

// ─── Run 生命周期 ────────────────────────────────────────────

/** createRun 的拒绝原因（不抛异常，由 spawn 工具转 ok:false）。 */
export type CreateRunRejection =
 | { kind: "definition_not_found"; definitionId: string }
 | { kind: "concurrency_cap"; active: number; cap: number }
 | { kind: "write_scope_overlap"; conflictingRunId: string };

export type CreateRunResult =
 | { ok: true; run: SubagentRun }
 | { ok: false; rejection: CreateRunRejection };

/**
 * 创建一个子代理 run（queued）+ subagent.spawned 事件。
 *
 * 校验（fail-closed）：
 * - 并发上限：同父 thread 活跃 run 数 >= cap → 拒绝。
 * - writeScope 互斥：同父 thread 活跃 run 的 writeScope 与本次重叠 → 拒绝（§14）。
 *
 * writeScope 取传入值或 definition.defaultWriteScope；null=只读。
 * transcriptPath 由调用方（runtime）在执行前回填，此处留空。
 */
export async function createRun(params: {
 parentThreadId: string;
 definitionId: string;
 goal: string;
 contextHints?: string[] | null;
 writeScope?: string[] | null;
 cap?: number;
}): Promise<CreateRunResult> {
 const cap = params.cap ?? DEFAULT_SUBAGENT_CONCURRENCY_CAP;
 const definition = await getDefinition(params.definitionId);
 if (!definition) {
 return {
 ok: false,
 rejection: { kind: "definition_not_found", definitionId: params.definitionId },
 };
 }
 const writeScope = params.writeScope ?? (definition.defaultWriteScope as string[] | null) ?? null;

 const active = await listActiveSubagentRunsByThread(params.parentThreadId);

 // 并发上限
 if (active.length >= cap) {
 return { ok: false, rejection: { kind: "concurrency_cap", active: active.length, cap } };
 }

 // writeScope 互斥：与任一活跃 run 的 writeScope 重叠 → 拒绝
 for (const r of active) {
 if (writeScopesOverlap(writeScope, (r.writeScope as string[] | null) ?? null)) {
 return {
 ok: false,
 rejection: { kind: "write_scope_overlap", conflictingRunId: r.id },
 };
 }
 }

 const run = await createSubagentRun({
 parentThreadId: params.parentThreadId,
 definitionId: params.definitionId,
 goal: params.goal,
 contextHints: params.contextHints ?? null,
 writeScope,
 });

 await appendThreadEvent(params.parentThreadId, "subagent.spawned", {
 runId: run.id,
 definitionId: definition.id,
 role: definition.role,
 goal: truncate(params.goal, 200),
 writeScope: writeScope ?? undefined,
 });

 return { ok: true, run };
}

/** 列 thread 的全部 run（按 createdAt desc）。 */
export async function listRunsByThread(parentThreadId: string): Promise<SubagentRun[]> {
 return listSubagentRunsByThread(parentThreadId);
}

export async function getRun(runId: string): Promise<SubagentRun | null> {
 return getSubagentRun(runId);
}

/** 列 thread 的活跃 run（queued/running）。供 finalize 取消用（Stage E）。 */
export async function listActiveRunsByThread(parentThreadId: string): Promise<SubagentRun[]> {
 return listActiveSubagentRunsByThread(parentThreadId);
}

/**
 * 取消同父 thread 的全部活跃子代理（queued/running → cancelled + subagent.joined 事件）。
 * 供 finalizeThreadRun 收尾调用，杜绝 orphan（计划 §1 / §12 风险）。
 *
 * best-effort：只切 DB 状态 + 事件；进程内正在执行的 streamText 循环不会被强行中断，
 * 其后续 updateRunStatus(completed/failed) 因 cancelled 不可迁回而被忽略（状态机守护）。
 */
export async function stopAllSubagents(parentThreadId: string): Promise<SubagentRun[]> {
 const active = await listActiveSubagentRunsByThread(parentThreadId);
 const cancelled: SubagentRun[] = [];
 for (const r of active) {
 const { cancelSubagentExecution } = await import("./runtime");
 cancelSubagentExecution(r.id);
 const updated = await updateRunStatus(r.id, "cancelled");
 if (updated) cancelled.push(updated);
 }
 return cancelled;
}

/** 状态机校验：from → to 是否合法。 */
export function canTransition(from: SubagentRunStatus, to: SubagentRunStatus): boolean {
 return TRANSITIONS[from].includes(to);
}

/**
 * 更新 run 状态（状态机）+ 对应事件。
 *
 * - queued→running：写 startedAt，不追加事件（spawned 已记录）。
 * - →completed：写 finishedAt + resultSummary/outputArtifactId + subagent.joined 事件。
 * - →failed/timed_out：写 finishedAt + errorMessage + subagent.failed 事件。
 * - →cancelled：写 finishedAt + subagent.joined 事件（status=cancelled，非失败）。
 *
 * 非法迁移 / run 不存在 → 返回 null（调用方决定处理），不抛。
 */
export async function updateRunStatus(
 runId: string,
 status: SubagentRunStatus,
 extra?: {
 resultSummary?: string | null;
 outputArtifactId?: string | null;
 errorMessage?: string | null;
 },
): Promise<SubagentRun | null> {
 const run = await getRun(runId);
 if (!run) return null;
 if (!canTransition(run.status, status)) {
 logger.warn("subagent run 非法状态迁移", { runId, from: run.status, to: status });
 return null;
 }

 const now = new Date();
 const patch: Parameters<typeof updateSubagentRun>[1] = { status };
 // : CAS——把读到的 status 作为 expectedStatus,UPDATE 仅在该值未变时生效,防并发覆盖。
 patch.expectedStatus = run.status;
 if (status === "running") patch.startedAt = now;
 if (TERMINAL_STATUSES.includes(status)) patch.finishedAt = now;
 if (extra?.resultSummary !== undefined) patch.resultSummary = extra.resultSummary;
 if (extra?.outputArtifactId !== undefined) patch.outputArtifactId = extra.outputArtifactId;
 if (extra?.errorMessage !== undefined) patch.errorMessage = extra.errorMessage;

 const updated = await updateSubagentRun(runId, patch);
 if (!updated) {
 // : CAS 冲突——状态已被并发改写(canTransition 在调用前已校验,此处直接放弃)。
 logger.warn("subagent run CAS 冲突,放弃状态迁移", { runId, from: run.status, to: status });
 return null;
 }

 // 终态事件
 if (status === "completed" || status === "cancelled") {
 await appendThreadEvent(run.parentThreadId, "subagent.joined", {
 runId,
 status,
 resultSummary: truncate(updated.resultSummary ?? "", 200),
 outputArtifactId: updated.outputArtifactId ?? undefined,
 });
 } else if (status === "failed" || status === "timed_out") {
 await appendThreadEvent(run.parentThreadId, "subagent.failed", {
 runId,
 status,
 errorMessage: truncate(updated.errorMessage ?? "", 200),
 });
 }

 return updated;
}

// ─── outputSchema 校验 ───────────────────────────────────────
//
// 子代理结束输出必须经 outputSchema（JSON Schema）校验，不合格 → status=failed。
// 实现一个覆盖常用 keyword 的轻量校验器（type/required/properties/items/enum/
// additionalProperties），不引入 ajv 依赖。null schema = 不校验（always ok）。

export type OutputValidation = { ok: true } | { ok: false; error: string };

export function validateOutput(
 result: unknown,
 schema: Record<string, unknown> | null,
): OutputValidation {
 if (!schema) return { ok: true };
 const err = validateNode(result, schema, "root");
 return err ? { ok: false, error: err } : { ok: true };
}

function validateNode(
 value: unknown,
 schema: Record<string, unknown>,
 path: string,
): string | null {
 const type = schema.type;
 if (typeof type === "string" && !matchesType(value, type)) {
 return `${path}: 期望类型 ${type}，实际 ${typeName(value)}`;
 }
 if (Array.isArray(type)) {
 if (!type.some((t) => matchesType(value, t))) {
 return `${path}: 期望类型 ${type.join("|")}，实际 ${typeName(value)}`;
 }
 }
 if (Array.isArray(schema.enum) && !schema.enum.includes(value)) {
 return `${path}: 值不在 enum 内`;
 }
 // 字符串长度约束
 if (typeof value === "string") {
 if (typeof schema.minLength === "number" && value.length < schema.minLength) {
 return `${path}: 字符串长度 ${value.length} < minLength ${schema.minLength}`;
 }
 if (typeof schema.maxLength === "number" && value.length > schema.maxLength) {
 return `${path}: 字符串长度 ${value.length} > maxLength ${schema.maxLength}`;
 }
 if (typeof schema.pattern === "string") {
 try {
 if (!new RegExp(schema.pattern).test(value)) {
 return `${path}: 不匹配 pattern ${schema.pattern}`;
 }
 } catch {
 // 非法 pattern 忽略（不阻断校验）
 }
 }
 }
 // 数值范围约束
 if (typeof value === "number") {
 if (typeof schema.minimum === "number" && value < schema.minimum) {
 return `${path}: 数值 ${value} < minimum ${schema.minimum}`;
 }
 if (typeof schema.maximum === "number" && value > schema.maximum) {
 return `${path}: 数值 ${value} > maximum ${schema.maximum}`;
 }
 }
 if (typeof value === "object" && value !== null && !Array.isArray(value)) {
 const obj = value as Record<string, unknown>;
 const props = (schema.properties ?? {}) as Record<string, Record<string, unknown>>;
 if (Array.isArray(schema.required)) {
 for (const key of schema.required) {
 if (!(key in obj)) return `${path}: 缺少必填字段 ${key}`;
 }
 }
 for (const [key, sub] of Object.entries(props)) {
 if (key in obj) {
 const subErr = validateNode(obj[key], sub, `${path}.${key}`);
 if (subErr) return subErr;
 }
 }
 const addl = schema.additionalProperties;
 if (addl === false) {
 for (const key of Object.keys(obj)) {
 if (!(key in props)) return `${path}: 不允许的额外字段 ${key}`;
 }
 }
 }
 if (Array.isArray(value) && schema.items && typeof schema.items === "object") {
 const items = schema.items as Record<string, unknown>;
 // 数组长度约束
 if (typeof schema.minItems === "number" && value.length < schema.minItems) {
 return `${path}: 数组长度 ${value.length} < minItems ${schema.minItems}`;
 }
 if (typeof schema.maxItems === "number" && value.length > schema.maxItems) {
 return `${path}: 数组长度 ${value.length} > maxItems ${schema.maxItems}`;
 }
 for (let i = 0; i < value.length; i++) {
 const subErr = validateNode(value[i], items, `${path}[${i}]`);
 if (subErr) return subErr;
 }
 }
 return null;
}

function matchesType(value: unknown, type: string): boolean {
 switch (type) {
 case "string":
 return typeof value === "string";
 case "number":
 case "integer":
 return typeof value === "number" && (type !== "integer" || Number.isInteger(value));
 case "boolean":
 return typeof value === "boolean";
 case "object":
 return typeof value === "object" && value !== null && !Array.isArray(value);
 case "array":
 return Array.isArray(value);
 case "null":
 return value === null;
 default:
 return true;
 }
}

function typeName(value: unknown): string {
 if (value === null) return "null";
 if (Array.isArray(value)) return "array";
 return typeof value;
}

// ─── 共用 ────────────────────────────────────────────────────

/** 截断事件 payload 中的长文本（goal/resultSummary/errorMessage），避免事件膨胀。 */
function truncate(text: string, max: number): string {
 return text.length > max ? `${text.slice(0, max)}…` : text;
}

export { ACTIVE_STATUSES, TERMINAL_STATUSES };
