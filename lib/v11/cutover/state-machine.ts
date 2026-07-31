/**
 * S13-W04 切换状态机：定义切换窗口的合法状态、转换与守卫条件。
 *
 * 事实源：../v11-agentkit-platform-development-plan/13-migration-cutover-and-release.md §S13-W04
 *         （切换前完成备份、恢复点、容量预热、告警静默边界、值守与回滚责任确认；
 *           先冻结旧写入口并等待进行中的 Invocation/ToolCall/Effect 到安全点，再执行最后增量迁移；
 *           不启用长期双写；切换窗口内只允许明确的只读核对和一次最终增量；
 *           冻结或切换失败时恢复旧入口，V11 新写入不得与旧事实源同时对员工开放）。
 *
 * 状态机：
 *   idle → precheck → backup_ready → write_frozen → drained → incremental_migration
 *        → cutover_ready → cutover_completed
 *   任意失败状态 → rolled_back
 *
 * 设计要点：
 * - 状态转换必须是显式的，禁止隐式跳转。
 * - 每次转换记录到会话历史，支持审计与断点续跑。
 * - rolled_back 是终态，不再允许前进；cutover_completed 也是终态。
 * - 切换窗口内（write_frozen ~ cutover_completed）旧入口冻结，V11 入口未对员工开放。
 */
import type { CutoverSession, CutoverStepRecord } from "@/lib/v11/cutover/session-store";

// ─── 切换状态 ──────────────────────────────────────────────

/** 切换会话状态。 */
export type CutoverState =
  | "idle" // 初始态，未启动
  | "precheck" // 前置检查中
  | "backup_ready" // 备份与恢复点就绪
  | "write_frozen" // 旧写入口已冻结
  | "drained" // 进行中操作已排空
  | "incremental_migration" // 最终增量迁移中
  | "cutover_ready" // 切换就绪（一致性核对通过）
  | "cutover_completed" // 切换完成（V11 已对员工开放，旧入口保持冻结）
  | "rolled_back"; // 已回滚（旧入口恢复，V11 隔离）

/** 终态集合。 */
export const TERMINAL_STATES: ReadonlySet<CutoverState> = new Set([
  "cutover_completed",
  "rolled_back",
]);

/** 切换窗口内状态（旧入口冻结，V11 未对员工开放）。 */
export const CUTOVER_WINDOW_STATES: ReadonlySet<CutoverState> = new Set([
  "write_frozen",
  "drained",
  "incremental_migration",
  "cutover_ready",
]);

// ─── 状态转换定义 ──────────────────────────────────────────

/** 合法的状态转换（from → to）。 */
const LEGAL_TRANSITIONS: ReadonlyMap<CutoverState, ReadonlySet<CutoverState>> = new Map([
  ["idle", new Set(["precheck"])],
  ["precheck", new Set(["backup_ready", "rolled_back"])],
  ["backup_ready", new Set(["write_frozen", "rolled_back"])],
  ["write_frozen", new Set(["drained", "rolled_back"])],
  ["drained", new Set(["incremental_migration", "rolled_back"])],
  ["incremental_migration", new Set(["cutover_ready", "rolled_back"])],
  ["cutover_ready", new Set(["cutover_completed", "rolled_back"])],
  ["cutover_completed", new Set()], // 终态
  ["rolled_back", new Set()], // 终态
]);

/** 检查状态转换是否合法。 */
export function isLegalTransition(from: CutoverState, to: CutoverState): boolean {
  const allowed = LEGAL_TRANSITIONS.get(from);
  return allowed?.has(to) ?? false;
}

/** 获取某状态的合法后继状态。 */
export function getLegalNextStates(state: CutoverState): readonly CutoverState[] {
  return [...(LEGAL_TRANSITIONS.get(state) ?? [])];
}

/** 判断状态是否为终态。 */
export function isTerminalState(state: CutoverState): boolean {
  return TERMINAL_STATES.has(state);
}

/** 判断状态是否在切换窗口内（旧入口冻结，V11 未对员工开放）。 */
export function isInCutoverWindow(state: CutoverState): boolean {
  return CUTOVER_WINDOW_STATES.has(state);
}

// ─── 状态转换错误 ──────────────────────────────────────────

/** 状态转换错误（非法转换、守卫失败等）。 */
export class CutoverTransitionError extends Error {
  constructor(
    message: string,
    readonly fromState: CutoverState,
    readonly toState: CutoverState,
    readonly sessionId: string,
  ) {
    super(message);
    this.name = "CutoverTransitionError";
  }
}

// ─── 状态转换守卫 ──────────────────────────────────────────

/** 转换守卫函数：返回 { passed, reason }，passed=false 时阻止转换。 */
export type TransitionGuard = (session: CutoverSession) => TransitionGuardResult;

/** 守卫检查结果。 */
export interface TransitionGuardResult {
  readonly passed: boolean;
  readonly reason: string;
}

/**
 * 注册的状态转换守卫（from → to → guards[]）。
 * 守卫按顺序执行，任一失败即阻止转换。
 */
const TRANSITION_GUARDS: Map<CutoverState, Map<CutoverState, TransitionGuard[]>> = new Map();

/**
 * 注册状态转换守卫。
 * 同一 (from, to) 可注册多个守卫，按注册顺序执行。
 */
export function registerTransitionGuard(
  from: CutoverState,
  to: CutoverState,
  guard: TransitionGuard,
): void {
  if (!isLegalTransition(from, to)) {
    throw new Error(`非法状态转换：${from} → ${to}，无法注册守卫`);
  }
  let toMap = TRANSITION_GUARDS.get(from);
  if (!toMap) {
    toMap = new Map();
    TRANSITION_GUARDS.set(from, toMap);
  }
  let guards = toMap.get(to);
  if (!guards) {
    guards = [];
    toMap.set(to, guards);
  }
  guards.push(guard);
}

/**
 * 执行状态转换守卫检查。
 * 返回第一个失败的守卫结果；全部通过返回 { passed: true }。
 */
export function runTransitionGuards(
  from: CutoverState,
  to: CutoverState,
  session: CutoverSession,
): TransitionGuardResult {
  if (!isLegalTransition(from, to)) {
    return {
      passed: false,
      reason: `非法状态转换：${from} → ${to}`,
    };
  }
  const toMap = TRANSITION_GUARDS.get(from);
  if (!toMap) return { passed: true, reason: "" };
  const guards = toMap.get(to);
  if (!guards || guards.length === 0) return { passed: true, reason: "" };
  for (const guard of guards) {
    const result = guard(session);
    if (!result.passed) return result;
  }
  return { passed: true, reason: "" };
}

/** 清空所有注册的守卫（测试用）。 */
export function clearTransitionGuards(): void {
  TRANSITION_GUARDS.clear();
}

// ─── 状态机应用层 ──────────────────────────────────────────

/** 状态转换请求。 */
export interface TransitionRequest {
  readonly sessionId: string;
  readonly from: CutoverState;
  readonly to: CutoverState;
  readonly operator: string;
  readonly reason: string;
}

/** 状态转换结果。 */
export interface TransitionResult {
  readonly success: boolean;
  readonly session: CutoverSession;
  readonly stepRecord: CutoverStepRecord | null;
  readonly error: string | null;
}

/**
 * 构造状态步骤记录（不修改会话状态，仅生成记录）。
 * 由 session-store 负责实际持久化。
 */
export function buildStepRecord(
  request: TransitionRequest,
  result: TransitionGuardResult,
): CutoverStepRecord {
  return {
    sessionId: request.sessionId,
    fromState: request.from,
    toState: request.to,
    operator: request.operator,
    reason: request.reason,
    guardResult: result.reason,
    timestamp: new Date().toISOString(),
    success: result.passed,
  };
}
