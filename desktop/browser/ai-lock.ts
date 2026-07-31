/**
 * V10 Phase 6-5：Desktop AI 锁状态机。
 *
 * 实现 02-desktop-browser-architecture.md §6 与 03-agent-bridge-security.md §6
 * 规定的 AI 锁和用户接管流程。
 *
 * 安全约束：
 * - Server 是 AI lock lease 的唯一事实源；Desktop 本地锁是 Secondary 强制
 * - Desktop 收到锁变化后禁用对应 tab 的用户导航命令，并使用 WebContents 覆盖层阻止页面输入
 * - AI 命令必须携带匹配的 runId 和未过期 lease
 * - Desktop 不允许 renderer 自行伪造锁释放
 * - 网络断开时 Desktop 不立即认为锁已释放；等待 lease 本地计时过期后进入明确的"需要重连确认"状态
 *
 * Phase 6-5 流程：
 * 1. AI 命令到达 → Server acquire lease → Desktop 收到 RPC 携带 runId → Desktop 本地 acquire AI 锁
 * 2. AI 持锁期间 → BrowserController 显示 overlay → 用户输入被阻止
 * 3. AI 完成 / Server release → Desktop 收到 lease_released → Desktop 释放本地锁 → overlay 移除
 * 4. 用户点击"停止并接管" → Desktop cancel 本地锁 → 通知 Server release → Server 通知 AI 当前命令 interrupted
 *
 * 注意：AiLockManager 在 Desktop 主进程运行，不依赖 electron API，便于单元测试。
 */
import type { TabId, ThreadId } from "./tab-store";

/**
 * 默认 AI 锁 TTL：5 分钟（与 Server lease TTL 保持一致）。
 *
 * Desktop 本地锁的 TTL 用于网络断开时的降级：lease 自然过期后 Desktop
 * 进入"需要重连确认"状态，而不是立即释放锁。
 */
export const AI_LOCK_DEFAULT_TTL_MS = 5 * 60 * 1000;

/**
 * AI 锁条目（内存状态）。
 *
 * 字段对齐 Server BrowserLease，但本地锁独立维护——Server 是事实源，
 * Desktop 本地锁为 Secondary 强制，防止 RPC 信封绕过 Server lease 直接执行。
 */
export interface AiLockEntry {
  /** 绑定的 thread ID */
  threadId: ThreadId;
  /** 持有锁的用户 ID */
  userId: string;
  /** 持有锁的设备 ID */
  deviceId: string;
  /** 绑定的 ThreadRun ID（与 RPC 信封 runId 匹配） */
  runId: string;
  /** 获取时间（epoch ms） */
  acquiredAt: number;
  /** 过期时间（epoch ms） */
  expiresAt: number;
}

/**
 * 锁释放原因（用于审计与事件回调）。
 *
 * - manual：AI 命令完成，Server 主动 release
 * - cancelled：用户点击"停止并接管"
 * - expired：lease TTL 自然过期（网络断开场景）
 * - revoked：Server 强制撤销（设备接管场景）
 */
export type LockReleaseReason = "manual" | "cancelled" | "expired" | "revoked";

/**
 * 锁事件回调类型。
 */
export type LockAcquireCallback = (lock: AiLockEntry) => void;
export type LockReleaseCallback = (info: {
  threadId: ThreadId;
  runId: string;
  deviceId: string;
  reason: LockReleaseReason;
}) => void;

/**
 * acquire 返回类型。
 */
export type LockAcquireResult = { ok: true; lock: AiLockEntry } | { ok: false; code: string };

/**
 * cancel 返回类型。
 */
export interface CancelResult {
  /** 是否成功取消（无锁时为 false） */
  cancelled: boolean;
  /** 被取消的 runId（无锁时为 null） */
  runId: string | null;
}

/**
 * 检查锁是否有效（未过期）。
 *
 * expiresAt === now 视为已过期（边界一致性）。
 *
 * @param lock 待检查的锁
 * @param now 当前时间（epoch ms）
 * @returns 未过期返回 true
 */
export function isLockValid(lock: AiLockEntry, now: number): boolean {
  return now < lock.expiresAt;
}

/**
 * 检查锁是否需要续期（剩余时间 < 1/3 TTL）。
 *
 * 与 Server LeaseManager.needsRenewal 一致，便于 Desktop 主动续期。
 *
 * @param lock 待检查的锁
 * @param now 当前时间（epoch ms）
 * @returns 需要续期返回 true
 */
export function lockNeedsRenewal(lock: AiLockEntry, now: number): boolean {
  const remaining = lock.expiresAt - now;
  if (remaining <= 0) {
    return true;
  }
  const ttl = lock.expiresAt - lock.acquiredAt;
  return remaining < ttl / 3;
}

/**
 * AiLockManager - Desktop 本地 AI 锁状态机。
 *
 * 维护 threadId → AiLockEntry 映射。提供 acquire/release/cancel/查询 功能。
 * 通过 onLocked/onReleased 回调通知 BrowserController 显示/移除 overlay。
 *
 * 注意：
 * - 同一 deviceId + 同一 runId 续期（更新 expiresAt）
 * - 同一 deviceId + 不同 runId 替换锁（新 runId 接管）
 * - 不同 deviceId 持有有效锁 → 拒绝（lock_held_by_other）
 * - cancel 由用户触发，AI 无法自行 cancel
 */
export class AiLockManager {
  private locks = new Map<ThreadId, AiLockEntry>();
  private acquireCallbacks = new Set<LockAcquireCallback>();
  private releaseCallbacks = new Set<LockReleaseCallback>();

  /**
   * 获取 lease（不存在返回 null）。
   */
  getLock(threadId: ThreadId): AiLockEntry | null {
    return this.locks.get(threadId) ?? null;
  }

  /**
   * 检查 thread 是否被 AI 持锁。
   *
   * 过期锁视为未持锁（不主动清理，由 cleanupExpired 统一处理）。
   *
   * @param threadId thread ID
   * @param now 可选当前时间，默认 Date.now()
   */
  isLocked(threadId: ThreadId, now: number = Date.now()): boolean {
    const lock = this.locks.get(threadId);
    if (!lock) return false;
    return isLockValid(lock, now);
  }

  /**
   * 检查指定 tab 的用户输入是否被阻止。
   *
   * AI 持锁时所有 tab 的用户输入都被阻止（overlay 覆盖整个 WebContents）。
   * tabId 参数保留用于未来精细化锁（per-tab 锁），当前实现为 thread 级锁。
   *
   * @param threadId thread ID
   * @param _tabId tab ID（当前未使用，保留扩展）
   * @param now 可选当前时间
   */
  isInputBlocked(threadId: ThreadId, _tabId: TabId, now: number = Date.now()): boolean {
    return this.isLocked(threadId, now);
  }

  /**
   * 获取 AI 锁。
   *
   * 流程：
   * 1. 已有锁 + 有效 + 同 deviceId + 同 runId → 续期
   * 2. 已有锁 + 有效 + 同 deviceId + 不同 runId → 替换锁（新 runId 接管）
   * 3. 已有锁 + 有效 + 不同 deviceId → 拒绝 lock_held_by_other
   * 4. 已有锁 + 过期 → 清理后获取
   * 5. 无锁 → 获取
   *
   * @returns 获取成功返回锁，失败返回错误码
   */
  acquire(params: {
    threadId: ThreadId;
    userId: string;
    deviceId: string;
    runId: string;
    now: number;
    ttlMs?: number;
  }): LockAcquireResult {
    const { threadId, userId, deviceId, runId, now, ttlMs = AI_LOCK_DEFAULT_TTL_MS } = params;
    const existing = this.locks.get(threadId);
    if (existing) {
      if (isLockValid(existing, now)) {
        // 有效锁
        if (existing.deviceId === deviceId) {
          // 同设备：续期或替换 runId
          const lock: AiLockEntry = {
            threadId,
            userId,
            deviceId,
            runId,
            acquiredAt: now,
            expiresAt: now + ttlMs,
          };
          this.locks.set(threadId, lock);
          this.emitAcquire(lock);
          return { ok: true, lock };
        }
        // 不同设备持锁
        return { ok: false, code: "lock_held_by_other" };
      }
      // 过期，清理后获取
      this.locks.delete(threadId);
    }
    const lock: AiLockEntry = {
      threadId,
      userId,
      deviceId,
      runId,
      acquiredAt: now,
      expiresAt: now + ttlMs,
    };
    this.locks.set(threadId, lock);
    this.emitAcquire(lock);
    return { ok: true, lock };
  }

  /**
   * 释放锁（只有持有锁的 deviceId + runId 能释放）。
   *
   * 用于 AI 命令完成、Server release 场景。
   *
   * @returns 释放成功返回 true
   */
  release(threadId: ThreadId, deviceId: string, runId: string, _now: number): boolean {
    const existing = this.locks.get(threadId);
    if (!existing) return false;
    if (existing.deviceId !== deviceId) return false;
    if (existing.runId !== runId) return false;
    this.locks.delete(threadId);
    this.emitRelease({
      threadId,
      runId: existing.runId,
      deviceId: existing.deviceId,
      reason: "manual",
    });
    return true;
  }

  /**
   * 用户取消锁（"停止并接管"流程）。
   *
   * 不校验 deviceId/runId 身份——用户始终有权取消本机 AI 锁。
   * 取消后通知 Server release lease，Server 通知 AI 当前命令 interrupted。
   *
   * @returns cancelled=true 表示有锁被取消，cancelled=false 表示无锁
   */
  cancel(threadId: ThreadId, _now: number): CancelResult {
    const existing = this.locks.get(threadId);
    if (!existing) {
      return { cancelled: false, runId: null };
    }
    const runId = existing.runId;
    const deviceId = existing.deviceId;
    this.locks.delete(threadId);
    this.emitRelease({ threadId, runId, deviceId, reason: "cancelled" });
    return { cancelled: true, runId };
  }

  /**
   * Server 强制撤销锁（设备接管场景，收到 lease_revoked 消息时调用）。
   *
   * @returns 撤销成功返回 true
   */
  revoke(threadId: ThreadId): boolean {
    const existing = this.locks.get(threadId);
    if (!existing) return false;
    this.locks.delete(threadId);
    this.emitRelease({
      threadId,
      runId: existing.runId,
      deviceId: existing.deviceId,
      reason: "revoked",
    });
    return true;
  }

  /**
   * 过期清理。
   *
   * @returns 清理的锁数量
   */
  cleanupExpired(now: number): number {
    let cleaned = 0;
    for (const [key, lock] of this.locks) {
      if (!isLockValid(lock, now)) {
        this.locks.delete(key);
        this.emitRelease({
          threadId: lock.threadId,
          runId: lock.runId,
          deviceId: lock.deviceId,
          reason: "expired",
        });
        cleaned++;
      }
    }
    return cleaned;
  }

  /**
   * 获取所有锁（含已过期未清理的）。
   */
  getAllLocks(): AiLockEntry[] {
    return Array.from(this.locks.values());
  }

  // ─── 事件订阅 ─────────────────────────────────────

  /**
   * 订阅锁获取事件（acquire 续期/替换也触发）。
   *
   * @returns 取消订阅函数
   */
  onLocked(callback: LockAcquireCallback): () => void {
    this.acquireCallbacks.add(callback);
    return () => {
      this.acquireCallbacks.delete(callback);
    };
  }

  /**
   * 订阅锁释放事件（manual/cancelled/expired/revoke 都触发）。
   *
   * @returns 取消订阅函数
   */
  onReleased(callback: LockReleaseCallback): () => void {
    this.releaseCallbacks.add(callback);
    return () => {
      this.releaseCallbacks.delete(callback);
    };
  }

  // ─── 内部 ─────────────────────────────────────

  private emitAcquire(lock: AiLockEntry): void {
    for (const cb of this.acquireCallbacks) {
      cb(lock);
    }
  }

  private emitRelease(info: {
    threadId: ThreadId;
    runId: string;
    deviceId: string;
    reason: LockReleaseReason;
  }): void {
    for (const cb of this.releaseCallbacks) {
      cb(info);
    }
  }
}
