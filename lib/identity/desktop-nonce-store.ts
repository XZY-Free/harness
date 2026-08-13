/**
 * Desktop 签名 Nonce 重放保护存储（S12-W05）。
 *
 * 事实源：docs/architecture/security.md §5
 * （Desktop 重放保护：签名 payload 含 nonce，TTL 内不可重复使用）。
 *
 * 职责：
 * - 进程内维护已使用的 (deviceKey, nonce) 集合，TTL 与签名时间窗口对齐。
 * - assertNonceNotReplayed：校验 nonce 未被使用过；首次见到的 nonce 写入存储。
 * - 清理过期 nonce（超过 DESKTOP_SIGNATURE_WINDOW_MS 的 nonce 自动失效）。
 *
 * 不变量：
 * - 同一 (deviceKey, nonce) 在 TTL 内只能使用一次。
 * - 进程重启后存储清空（可接受：时间窗口仅 5min，重放窗口窄）。
 * - 多实例部署下各实例独立存储（可接受：负载均衡后重放概率低；
 * 完整防护需要 Redis 共享存储，由后续阶段实现）。
 */
import { DESKTOP_SIGNATURE_WINDOW_MS } from "@/lib/identity/device-signature";

/** Nonce 存储条目。 */
interface NonceEntry {
  /** nonce 值（由客户端生成，建议 16+ 字符随机串）。 */
  nonce: string;
  /** 过期时间戳（ms）。 */
  expiresAt: number;
}

/** 进程内 nonce 存储：按 deviceKey 分桶，每桶维护 nonce 集合。 */
const store = new Map<string, Map<string, NonceEntry>>();

/** 上次清理时间戳（ms），避免每次调用都触发清理。 */
let lastGcAt = 0;

/** GC 间隔（ms）：每 5min 清理一次过期 nonce。 */
const GC_INTERVAL_MS = 5 * 60 * 1000;

/**
 * 校验 nonce 未被使用过；首次见到的 nonce 写入存储。
 *
 * @param deviceKey 设备 key（按设备分桶，避免不同设备 nonce 冲突）
 * @param nonce 客户端生成的 nonce 值
 * @param timestamp 签名时间戳（用于计算 TTL）
 * @throws DesktopNonceError nonce 已被使用（重放攻击）或为空
 */
export function assertNonceNotReplayed(deviceKey: string, nonce: string, timestamp: number): void {
  if (!nonce) {
    throw new DesktopNonceError("missing_nonce", "缺少 X-Desktop-Nonce");
  }
  if (nonce.length < 8) {
    throw new DesktopNonceError("nonce_too_short", "nonce 长度不足 8 字符");
  }

  // 触发 GC（节流）
  const now = Date.now();
  if (now - lastGcAt > GC_INTERVAL_MS) {
    gc(now);
    lastGcAt = now;
  }

  let bucket = store.get(deviceKey);
  if (!bucket) {
    bucket = new Map();
    store.set(deviceKey, bucket);
  }

  const existing = bucket.get(nonce);
  if (existing && existing.expiresAt > now) {
    throw new DesktopNonceError(
      "nonce_replayed",
      `nonce ${nonce.slice(0, 4)}*** 已被使用（重放攻击）`,
    );
  }

  // 写入存储，TTL = 时间戳 + 签名窗口（即允许的最老签名时间 + 一个窗口）
  const expiresAt = timestamp + DESKTOP_SIGNATURE_WINDOW_MS * 2;
  bucket.set(nonce, { nonce, expiresAt });
}

/** 查询 nonce 是否已使用（仅测试用）。 */
export function isNonceUsed(deviceKey: string, nonce: string): boolean {
  const bucket = store.get(deviceKey);
  if (!bucket) return false;
  const entry = bucket.get(nonce);
  if (!entry) return false;
  return entry.expiresAt > Date.now();
}

/** 清理过期 nonce（按设备桶清理）。 */
export function gc(now: number = Date.now()): number {
  let removed = 0;
  for (const [deviceKey, bucket] of store) {
    for (const [nonce, entry] of bucket) {
      if (entry.expiresAt <= now) {
        bucket.delete(nonce);
        removed++;
      }
    }
    if (bucket.size === 0) {
      store.delete(deviceKey);
    }
  }
  return removed;
}

/** 清空所有 nonce（仅测试用）。 */
export function clearDesktopNonceStore(): void {
  store.clear();
  lastGcAt = 0;
}

/** Nonce 重放保护错误（route 层应映射为 401 AUTHENTICATION_REQUIRED）。 */
export class DesktopNonceError extends Error {
  constructor(
    public readonly code: "missing_nonce" | "nonce_too_short" | "nonce_replayed",
    message: string,
  ) {
    super(message);
    this.name = "DesktopNonceError";
  }
}
