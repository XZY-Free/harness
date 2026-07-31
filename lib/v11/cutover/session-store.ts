/**
 * S13-W04 切换会话存储：切换会话与步骤历史。
 *
 * 事实源：../v11-agentkit-platform-development-plan/13-migration-cutover-and-release.md §S13-W04
 *         （切换窗口内只允许明确的只读核对和一次最终增量；
 *           切换前完成备份、恢复点、容量预热、告警静默边界、值守与回滚责任确认）。
 *
 * 设计：
 * - 内存存储（测试用），接口可替换为 DB 后端（生产用）。
 * - 每个切换会话记录当前状态、操作人、时间戳与完整步骤历史。
 * - 步骤历史支持审计与断点续跑（恢复到上次状态）。
 * - 同一时刻只允许存在一个非终态会话（切换窗口互斥）。
 */
import { randomUUID } from "node:crypto";
import type { CutoverState } from "@/lib/v11/cutover/state-machine";

// ─── 会话记录 ──────────────────────────────────────────────

/** 切换会话。 */
export interface CutoverSession {
  /** 会话 ID（唯一）。 */
  readonly id: string;
  /** 当前状态。 */
  state: CutoverState;
  /** 发起操作人。 */
  readonly initiatedBy: string;
  /** 值守人员。 */
  onCallOperator: string | null;
  /** 回滚责任人。 */
  rollbackOwner: string | null;
  /** 创建时间（ISO 字符串）。 */
  readonly createdAt: string;
  /** 最后更新时间（ISO 字符串）。 */
  updatedAt: string;
  /** 完成时间（ISO 字符串，null 表示未完成）。 */
  completedAt: string | null;
  /** 备份恢复点标识（backup_ready 阶段写入）。 */
  backupRestorePoint: string | null;
  /** 切换窗口开始时间（write_frozen 阶段写入）。 */
  cutoverWindowStartedAt: string | null;
  /** 最终增量迁移批次 ID（incremental_migration 阶段写入）。 */
  incrementalBatchId: string | null;
  /** 失败原因（回滚时填充）。 */
  failureReason: string | null;
}

/** 单个状态步骤记录。 */
export interface CutoverStepRecord {
  /** 所属会话 ID。 */
  readonly sessionId: string;
  /** 转换前状态。 */
  readonly fromState: CutoverState;
  /** 转换后状态。 */
  readonly toState: CutoverState;
  /** 操作人。 */
  readonly operator: string;
  /** 转换原因。 */
  readonly reason: string;
  /** 守卫检查结果说明（失败时填充原因）。 */
  readonly guardResult: string;
  /** 步骤时间戳（ISO 字符串）。 */
  readonly timestamp: string;
  /** 步骤是否成功。 */
  readonly success: boolean;
}

// ─── 会话存储接口 ──────────────────────────────────────────

/** 切换会话存储接口（内存实现可用于测试，生产可替换为 DB 后端）。 */
export interface CutoverSessionStore {
  /** 创建新会话（同一时刻只允许一个非终态会话）。 */
  createSession(initiatedBy: string): CutoverSession;

  /** 获取会话。 */
  getSession(id: string): CutoverSession | undefined;

  /** 获取当前活跃会话（非终态）。 */
  getActiveSession(): CutoverSession | undefined;

  /** 列出所有会话。 */
  listSessions(): readonly CutoverSession[];

  /** 更新会话状态与字段。 */
  updateSession(
    id: string,
    updates: Partial<Omit<CutoverSession, "id" | "initiatedBy" | "createdAt">>,
  ): CutoverSession;

  /** 追加步骤记录。 */
  appendStep(step: CutoverStepRecord): void;

  /** 获取会话的步骤历史。 */
  getSteps(sessionId: string): readonly CutoverStepRecord[];

  /** 清空所有会话与步骤（测试用）。 */
  clear(): void;
}

// ─── 内存会话存储实现 ──────────────────────────────────────

/** 内存切换会话存储（测试和开发用）。 */
export class InMemoryCutoverSessionStore implements CutoverSessionStore {
  private readonly sessions = new Map<string, CutoverSession>();
  private readonly steps = new Map<string, CutoverStepRecord[]>();

  createSession(initiatedBy: string): CutoverSession {
    // 互斥检查：同一时刻只允许一个非终态会话
    const active = this.getActiveSession();
    if (active) {
      throw new Error(
        `已存在活跃切换会话 ${active.id}（状态：${active.state}），必须先完成或回滚后才能创建新会话`,
      );
    }
    const now = new Date().toISOString();
    const session: CutoverSession = {
      id: randomUUID(),
      state: "idle",
      initiatedBy,
      onCallOperator: null,
      rollbackOwner: null,
      createdAt: now,
      updatedAt: now,
      completedAt: null,
      backupRestorePoint: null,
      cutoverWindowStartedAt: null,
      incrementalBatchId: null,
      failureReason: null,
    };
    this.sessions.set(session.id, session);
    this.steps.set(session.id, []);
    return session;
  }

  getSession(id: string): CutoverSession | undefined {
    return this.sessions.get(id);
  }

  getActiveSession(): CutoverSession | undefined {
    for (const session of this.sessions.values()) {
      if (session.state !== "cutover_completed" && session.state !== "rolled_back") {
        return session;
      }
    }
    return undefined;
  }

  listSessions(): readonly CutoverSession[] {
    return [...this.sessions.values()];
  }

  updateSession(
    id: string,
    updates: Partial<Omit<CutoverSession, "id" | "initiatedBy" | "createdAt">>,
  ): CutoverSession {
    const existing = this.sessions.get(id);
    if (!existing) {
      throw new Error(`切换会话不存在：${id}`);
    }
    const updated: CutoverSession = {
      ...existing,
      ...updates,
      updatedAt: new Date().toISOString(),
    };
    this.sessions.set(id, updated);
    return updated;
  }

  appendStep(step: CutoverStepRecord): void {
    let steps = this.steps.get(step.sessionId);
    if (!steps) {
      steps = [];
      this.steps.set(step.sessionId, steps);
    }
    steps.push(step);
  }

  getSteps(sessionId: string): readonly CutoverStepRecord[] {
    return [...(this.steps.get(sessionId) ?? [])];
  }

  clear(): void {
    this.sessions.clear();
    this.steps.clear();
  }
}
