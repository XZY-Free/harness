import { withAnalyticsCache } from "@/lib/analytics/cache";
import { db } from "@/lib/db/client";
import {
 type ThreadStatus,
 skill,
 thread,
 threadEvent,
 threadRun,
 threadRunSkill,
 toolRun,
} from "@/lib/db/schema";
/**
 * ：Analytics 聚合查询层（**纯只读**）。
 *
 * 把 事件流（`thread_events`）+ `tool_runs` + skill 绑定，聚合成运营指标。
 * 跨 thread 聚合，与 `lib/thread-events/projector.ts`（单 thread 投影）同源不同向。
 *
 * **头号纪律（）**：本模块只 `select` 不 mutate——不 import 任何写函数
 *（`updateThreadStatus` / `appendThreadEvent` / `finishToolRun*` / `insert` / `update`）。
 * Stage E 用 grep 把关。任何 mutation import 都破坏「零回归」承诺。
 *
 * 指标口径以本文件函数注释为准（），防 P4-4 UI 误读。
 *
 * ：所有聚合支持 `userId` scope。`/api/analytics` 默认只聚合当前用户数据，
 * 避免多用户指标互相泄露；全局运营指标留 P4-4 管理后台权限体系。
 */
import {
 type AnyColumn,
 type SQL,
 and,
 count,
 desc,
 eq,
 inArray,
 isNull,
 max,
 min,
 sql,
} from "drizzle-orm";

export type AnalyticsScope = { since?: Date; until?: Date; userId?: string };

/** 构造时间窗口过滤（`col >= since AND col <= until`）；无窗口返回 undefined。 */
function timeFilter(scope: AnalyticsScope | undefined, col: AnyColumn): SQL | undefined {
 const conds: SQL[] = [];
 if (scope?.since) conds.push(sql`${col} >= ${scope.since}`);
 if (scope?.until) conds.push(sql`${col} <= ${scope.until}`);
 return conds.length > 0 ? and(...conds) : undefined;
}

/** 合并多个可选条件，全部 undefined → undefined（drizzle `.where(undefined)` 为 no-op）。 */
function combine(...conds: Array<SQL | undefined>): SQL | undefined {
 const present = conds.filter((c): c is SQL => Boolean(c));
 return present.length > 0 ? and(...present) : undefined;
}

/**
 * 取 scope 用户拥有的 thread id 列表（供 toolRun / threadEvent 这类无 userId 列的表做归属过滤）。
 * 无 userId scope → null（表示不限定，全量聚合）。
 */
async function threadIdsForScope(scope?: AnalyticsScope): Promise<string[] | null> {
 if (!scope?.userId) return null;
 const rows = await db
 .select({ id: thread.id })
 .from(thread)
 .where(and(eq(thread.userId, scope.userId), isNull(thread.deletedAt)));
 return rows.map((r) => r.id);
}

// ─── thread 成功率（.1 口径） ────────────────────────────

export type ThreadSuccessMetric = {
 /**
 * `ready_for_review / (ready_for_review + failed)`。
 * **分母不含 `executing`**（进行中、未结束，不计成功率）；`idle` 单列为空跑率，不混入。
 * 分母为 0 → null（无已结束 thread）。
 */
 successRate: number | null;
 readyForReview: number;
 failed: number;
 /** 进行中、未结束——不计入成功率分母。 */
 executing: number;
 /** 有运行但无产出收尾——单列空跑率，不混入成功率。 */
 idle: number;
 /** `idle / (ready + failed + idle)`；无已结束 thread → null。 */
 idleRate: number | null;
 total: number;
};

export async function threadSuccessRate(scope?: AnalyticsScope): Promise<ThreadSuccessMetric> {
 return withAnalyticsCache("threadSuccessRate", scope, async () => {
 const rows = await db
 .select({ status: thread.status, count: count() })
 .from(thread)
 .where(
 combine(
 timeFilter(scope, thread.createdAt),
 scope?.userId ? eq(thread.userId, scope.userId) : undefined,
 ),
 )
 .groupBy(thread.status);

 const byStatus = new Map<ThreadStatus, number>();
 for (const r of rows) byStatus.set(r.status, Number(r.count));

 const readyForReview = byStatus.get("ready_for_review") ?? 0;
 const failed = byStatus.get("failed") ?? 0;
 const executing = byStatus.get("executing") ?? 0;
 const idle = byStatus.get("idle") ?? 0;
 const denom = readyForReview + failed;
 const endedTotal = readyForReview + failed + idle;

 return {
 successRate: denom === 0 ? null : readyForReview / denom,
 readyForReview,
 failed,
 executing,
 idle,
 idleRate: endedTotal === 0 ? null : idle / endedTotal,
 total: readyForReview + failed + executing + idle,
 };
 });
}

// ─── preview 成功率（reportReady 探活） ────────────────

export type PreviewSuccessMetric = {
 /** `succeeded / (succeeded + failed)`；reportReady 探活失败即落 business `failed`。running 不计分母。 */
 successRate: number | null;
 succeeded: number;
 failed: number;
 running: number;
 total: number;
};

const EMPTY_PREVIEW: PreviewSuccessMetric = {
 successRate: null,
 succeeded: 0,
 failed: 0,
 running: 0,
 total: 0,
};

export async function previewSuccessRate(scope?: AnalyticsScope): Promise<PreviewSuccessMetric> {
 return withAnalyticsCache("previewSuccessRate", scope, async () => {
 // 用户 scope 下无任何 owned thread → 直接空指标，不查 toolRun
 const scopedThreadIds = await threadIdsForScope(scope);
 if (scopedThreadIds && scopedThreadIds.length === 0) return EMPTY_PREVIEW;

 const rows = await db
 .select({ status: toolRun.status, count: count() })
 .from(toolRun)
 .where(
 combine(
 eq(toolRun.toolName, "reportReady"),
 timeFilter(scope, toolRun.startedAt),
 scopedThreadIds ? inArray(toolRun.threadId, scopedThreadIds) : undefined,
 ),
 )
 .groupBy(toolRun.status);

 const byStatus = new Map<string, number>();
 for (const r of rows) byStatus.set(r.status, Number(r.count));

 const succeeded = byStatus.get("succeeded") ?? 0;
 const failed = byStatus.get("failed") ?? 0;
 const running = byStatus.get("running") ?? 0;
 const denom = succeeded + failed;

 return {
 successRate: denom === 0 ? null : succeeded / denom,
 succeeded,
 failed,
 running,
 total: succeeded + failed + running,
 };
 });
}

// ─── thread 生命周期（时长 / skill 表现共享） ────────────────

/**
 * 单 thread 生命周期投影：起点 → 终态时间戳，供 avgCompletionMs / perSkillPerformance 复用。
 *
 * - startMs：`agent.started` 事件 createdAt；缺则退回 `thread.createdAt`（.3）。
 * - endMs：终态 `agent.status_changed`（to ∈ idle/ready_for_review/failed）的 createdAt；
 * 无终态（仍 executing）→ null，下游 fail-soft 跳过，不污染均值。
 *
 * 三次只读 select（窗口内 thread → 各自的 start/end 事件），TS 侧 join。
 * 量小实时聚合可接受（§7）；量大再优化。
 *
 * ：thread 首次 select 按 scope.userId 限定归属。
 */
type Lifespan = {
 threadId: string;
 skillId: string | null;
 skillVersionId: string | null;
 status: ThreadStatus;
 startMs: number;
 endMs: number | null;
};

async function fetchLifespans(scope?: AnalyticsScope): Promise<Lifespan[]> {
 // V8 阶段 7：Skill 统计改用 ThreadRunSkill（primary role），不再从 thread.activeSkillId 读。
 // 每个 thread 取最近一次 run 的 primary skill（无 Skill run → skillId=null，单独统计）。
 const threads = await db
 .select({
 id: thread.id,
 createdAt: thread.createdAt,
 status: thread.status,
 skillId: threadRunSkill.skillId,
 skillVersionId: threadRunSkill.skillVersionId,
 })
 .from(thread)
 // 最近一次 ThreadRun（子查询取 max createdAt per thread）
 .leftJoin(
 threadRun,
 eq(
 threadRun.id,
 db
 .select({ id: threadRun.id })
 .from(threadRun)
 .where(eq(threadRun.threadId, thread.id))
 .orderBy(desc(threadRun.createdAt))
 .limit(1),
 ),
 )
 // 该 run 的 primary skill（无则 skillId 为 null）
 .leftJoin(
 threadRunSkill,
 and(eq(threadRunSkill.runId, threadRun.id), eq(threadRunSkill.role, "primary")),
 )
 .where(
 combine(
 timeFilter(scope, thread.createdAt),
 scope?.userId ? eq(thread.userId, scope.userId) : undefined,
 isNull(thread.deletedAt),
 ),
 );

 if (threads.length === 0) return [];

 const threadIds = threads.map((t) => t.id);

 // 起点：agent.started 的最早 createdAt（每 thread 一条，groupBy + min 兜底重复）
 const starts = await db
 .select({ threadId: threadEvent.threadId, start: min(threadEvent.createdAt) })
 .from(threadEvent)
 .where(and(eq(threadEvent.type, "agent.started"), inArray(threadEvent.threadId, threadIds)))
 .groupBy(threadEvent.threadId);

 // 终态：to ∈ 终态集合的 status_changed 最新 createdAt（每 thread 至多一条，max 兜底）
 const ends = await db
 .select({ threadId: threadEvent.threadId, end: max(threadEvent.createdAt) })
 .from(threadEvent)
 .where(
 and(
 eq(threadEvent.type, "agent.status_changed"),
 inArray(threadEvent.threadId, threadIds),
 sql`JSON_EXTRACT(${threadEvent.payload}, '$.to') IN ('idle', 'ready_for_review', 'failed')`,
 ),
 )
 .groupBy(threadEvent.threadId);

 const startMap = new Map(starts.map((r) => [r.threadId, r.start?.getTime() ?? null]));
 const endMap = new Map(ends.map((r) => [r.threadId, r.end?.getTime() ?? null]));

 return threads.map((t) => ({
 threadId: t.id,
 skillId: t.skillId,
 skillVersionId: t.skillVersionId,
 status: t.status,
 startMs: startMap.get(t.id) ?? t.createdAt.getTime(),
 endMs: endMap.get(t.id) ?? null,
 }));
}

// ─── 平均完成时长（.3 fail-soft） ────────────────────────

export type AvgCompletionMetric = {
 /** 终态 thread 的 (endMs - startMs) 均值；无已结束 thread → null。 */
 avgMs: number | null;
 count: number;
};

export async function avgCompletionMs(scope?: AnalyticsScope): Promise<AvgCompletionMetric> {
 return withAnalyticsCache("avgCompletionMs", scope, async () => {
 const lifespans = await fetchLifespans(scope);
 let sum = 0;
 let n = 0;
 for (const l of lifespans) {
 if (l.endMs === null) continue; // 无终态（executing）→ fail-soft 跳过
 const d = l.endMs - l.startMs;
 if (d < 0) continue; // 异常时序（终态早于起点）→ fail-soft
 sum += d;
 n++;
 }
 return { avgMs: n === 0 ? null : sum / n, count: n };
 });
}

// ─── 各 skill 表现（group by skillId | skillVersionId） ──────

export type SkillPerformance = {
 /** 最近一次 run 的 primary skill；null 表该 thread 最近 run 未使用 Skill（基础 agent）。 */
 skillId: string | null;
 /** skill 可读名（`skill.name`，如 build-from-idea）；skillId 已删档或查不到 → null。 */
 skillName: string | null;
 skillVersionId: string | null;
 total: number;
 readyForReview: number;
 failed: number;
 executing: number;
 idle: number;
 /** 同 thread 成功率口径：ready/(ready+failed)，executing 不计分母。 */
 successRate: number | null;
 /** 该 skill 已结束 thread 的平均完成时长；无 → null。 */
 avgCompletionMs: number | null;
 completedCount: number;
};

export type PerSkillMetric = SkillPerformance[];

export async function perSkillPerformance(scope?: AnalyticsScope): Promise<PerSkillMetric> {
 return withAnalyticsCache("perSkillPerformance", scope, async () => {
 const lifespans = await fetchLifespans(scope);

 // 按 (skillId, skillVersionId) 复合分组；分组 key 内部用 "(none)" 占位（仅 Map 键，
 // 不进入输出），输出保留 first.skillId 原值（null 表无绑定，见 SkillPerformance 注释）。
 const groups = new Map<string, Lifespan[]>();
 for (const l of lifespans) {
 const key = `${l.skillId ?? "(none)"}|${l.skillVersionId ?? "(none)"}`;
 let bucket = groups.get(key);
 if (!bucket) {
 bucket = [];
 groups.set(key, bucket);
 }
 bucket.push(l);
 }

 // 批量取 skill 可读名：聚合所有非 null skillId 一次性 select，避免 N+1。
 // skillId 可能已删档（archived/物理删除）→ 查不到 → skillName=null，UI 回退显 skillId。
 const skillIds = [
 ...new Set(lifespans.map((l) => l.skillId).filter((id): id is string => Boolean(id))),
 ];
 const nameById = new Map<string, string>();
 if (skillIds.length > 0) {
 const rows = await db
 .select({ id: skill.id, name: skill.name })
 .from(skill)
 .where(inArray(skill.id, skillIds));
 for (const r of rows) nameById.set(r.id, r.name);
 }

 const out: SkillPerformance[] = [];
 for (const ls of groups.values()) {
 const first = ls[0];
 if (!first) continue; // 桶非空保证（push 时创建），防御 noUncheckedIndexedAccess
 const ready = ls.filter((l) => l.status === "ready_for_review").length;
 const failed = ls.filter((l) => l.status === "failed").length;
 const executing = ls.filter((l) => l.status === "executing").length;
 const idle = ls.filter((l) => l.status === "idle").length;
 const denom = ready + failed;
 const completed = ls.filter((l) => l.endMs !== null && l.endMs - l.startMs >= 0);
 const sumDur = completed.reduce((a, l) => a + ((l.endMs as number) - l.startMs), 0);

 out.push({
 skillId: first.skillId,
 skillName: first.skillId ? (nameById.get(first.skillId) ?? null) : null,
 skillVersionId: first.skillVersionId,
 total: ls.length,
 readyForReview: ready,
 failed,
 executing,
 idle,
 successRate: denom === 0 ? null : ready / denom,
 avgCompletionMs: completed.length === 0 ? null : sumDur / completed.length,
 completedCount: completed.length,
 });
 }
 return out;
 });
}

// ─── tool 失败分布 + policy 拦截率（闭合 P4-1） ─────────────

export type ToolFailureByTool = { toolName: string; status: string; count: number };
export type ToolFailureByKind = { failureKind: string; count: number };

export type ToolFailureBreakdown = {
 /** 按 (toolName, status) 计数——来自 tool_runs 真状态列。 */
 byTool: ToolFailureByTool[];
 /**
 * 按 failureKind 计数——来自 thread_events 的 tool.failed.payload（JSON_EXTRACT 聚合）。
 * **不给 tool_runs 加冗余列**（那是写路径变更，违反零回归，.2）。
 */
 byKind: ToolFailureByKind[];
 /** tool.failed 事件总数（byKind 求和）。 */
 totalFailures: number;
 /** failureKind="policy" 的计数——P4-1 治理拦截。 */
 policyIntercepts: number;
 /** `policy / totalFailures`；无 tool.failed → null。 */
 policyInterceptRate: number | null;
};

const EMPTY_TOOL_FAILURE: ToolFailureBreakdown = {
 byTool: [],
 byKind: [],
 totalFailures: 0,
 policyIntercepts: 0,
 policyInterceptRate: null,
};

export async function toolFailureBreakdown(scope?: AnalyticsScope): Promise<ToolFailureBreakdown> {
 return withAnalyticsCache("toolFailureBreakdown", scope, async () => {
 // 用户 scope 下无任何 owned thread → 直接空指标
 const scopedThreadIds = await threadIdsForScope(scope);
 if (scopedThreadIds && scopedThreadIds.length === 0) return EMPTY_TOOL_FAILURE;

 // 按 (toolName, status)：复用 ToolRun 的 (threadId,toolName) / (status,startedAt) 索引
 const byToolRows = await db
 .select({ toolName: toolRun.toolName, status: toolRun.status, count: count() })
 .from(toolRun)
 .where(
 combine(
 timeFilter(scope, toolRun.startedAt),
 scopedThreadIds ? inArray(toolRun.threadId, scopedThreadIds) : undefined,
 ),
 )
 .groupBy(toolRun.toolName, toolRun.status);

 // 按 failureKind：JSON_EXTRACT 聚合 tool.failed.payload（只读，不动写路径）
 const kindCol =
 sql<string>`JSON_UNQUOTE(JSON_EXTRACT(${threadEvent.payload}, '$.failureKind'))`.as(
 "failureKind",
 );
 const byKindRows = await db
 .select({ failureKind: kindCol, count: count() })
 .from(threadEvent)
 .where(
 combine(
 eq(threadEvent.type, "tool.failed"),
 timeFilter(scope, threadEvent.createdAt),
 scopedThreadIds ? inArray(threadEvent.threadId, scopedThreadIds) : undefined,
 ),
 )
 .groupBy(kindCol);

 const byKind: ToolFailureByKind[] = byKindRows.map((r) => ({
 failureKind: r.failureKind ?? "unknown",
 count: Number(r.count),
 }));
 const totalFailures = byKind.reduce((a, r) => a + r.count, 0);
 const policyIntercepts = byKind.find((r) => r.failureKind === "policy")?.count ?? 0;

 return {
 byTool: byToolRows.map((r) => ({
 toolName: r.toolName,
 status: r.status,
 count: Number(r.count),
 })),
 byKind,
 totalFailures,
 policyIntercepts,
 policyInterceptRate: totalFailures === 0 ? null : policyIntercepts / totalFailures,
 };
 });
}

// ─── skill 匹配统计（S1 11-P2-2：聚合 skills.matched 事件） ────

/**
 * 单 skill 的自动匹配统计。
 *
 * 数据源：thread_events 表 type='skills.matched' 事件（chat route 在 matchSkill 命中后落库）。
 * 与 perSkillPerformance（V8 改用 ThreadRunSkill primary role 关联）区别：
 * - perSkillPerformance：统计 skill 实际被使用的 thread 数（含手动选择 + 自动匹配）。
 * - skillMatchStats：只统计"自动匹配命中"次数,反映 skill description 触发词的命中频次。
 *
 * 两者互补:perSkillPerformance 看 skill 使用效果,skillMatchStats 看 skill 自动匹配活跃度。
 */
export type SkillMatchStat = {
 /** skill id（payload.skillId）；skill 已删档 → skillName 仍保留 payload 中的可读名。 */
 skillId: string;
 /** skill 可读名：优先 skill.name（join skill 表），skill 已删档 → payload.skillName。 */
 skillName: string;
 /** 自动匹配命中次数。 */
 matchCount: number;
 /** 最近命中时间；无命中 → null。 */
 lastMatchedAt: Date | null;
};

export type SkillMatchStats = SkillMatchStat[];

/**
 * 聚合 skills.matched 事件,按 skillId 统计命中次数 + 最近命中时间。
 *
 * - 从 threadEvent 表查 type='skills.matched',JSON_EXTRACT 取 payload.skillId/skillName。
 * - 按 skillId group by,count + max(createdAt)。
 * - 再 leftJoin skill 表取可读名（skill 已删档 → 用 payload.skillName 兜底）。
 *
 * ：userId scope 通过 threadIdsForScope 限定（skills.matched 事件无 userId 列,
 * 需 join thread 取归属）。无 userId scope → 全量聚合。
 */
export async function skillMatchStats(scope?: AnalyticsScope): Promise<SkillMatchStats> {
 return withAnalyticsCache("skillMatchStats", scope, async () => {
 // 用户 scope 下无任何 owned thread → 直接空指标
 const scopedThreadIds = await threadIdsForScope(scope);
 if (scopedThreadIds && scopedThreadIds.length === 0) return [];

 // 从 threadEvent 聚合 skills.matched 事件
 const skillIdCol =
 sql<string>`JSON_UNQUOTE(JSON_EXTRACT(${threadEvent.payload}, '$.skillId'))`.as("skillId");
 // ONLY_FULL_GROUP_BY：skillName 与 skillId 同组内应一致,用 MAX 聚合取代表值
 const skillNameAgg = sql<
 string | null
 >`MAX(JSON_UNQUOTE(JSON_EXTRACT(${threadEvent.payload}, '$.skillName')))`.as("skillName");

 const rows = await db
 .select({
 skillId: skillIdCol,
 skillName: skillNameAgg,
 matchCount: count(),
 lastMatchedAt: max(threadEvent.createdAt),
 })
 .from(threadEvent)
 .where(
 combine(
 eq(threadEvent.type, "skills.matched"),
 timeFilter(scope, threadEvent.createdAt),
 scopedThreadIds ? inArray(threadEvent.threadId, scopedThreadIds) : undefined,
 ),
 )
 .groupBy(skillIdCol);

 if (rows.length === 0) return [];

 // 批量取 skill 可读名（skill 表）,skill 已删档 → 用 payload.skillName 兜底
 const skillIds = [
 ...new Set(rows.map((r) => r.skillId).filter((id): id is string => Boolean(id))),
 ];
 const nameById = new Map<string, string>();
 if (skillIds.length > 0) {
 const nameRows = await db
 .select({ id: skill.id, name: skill.name })
 .from(skill)
 .where(inArray(skill.id, skillIds));
 for (const r of nameRows) nameById.set(r.id, r.name);
 }

 return rows.map((r) => {
 const id = r.skillId ?? "";
 const nameFromDb = id ? (nameById.get(id) ?? null) : null;
 const nameFromPayload = r.skillName ?? null;
 return {
 skillId: id,
 skillName: nameFromDb ?? nameFromPayload ?? id,
 matchCount: Number(r.matchCount),
 lastMatchedAt: r.lastMatchedAt ?? null,
 };
 });
 });
}
