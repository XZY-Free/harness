/**
 * 进程实例身份（A03-01 · FILE-080）。
 *
 * Hosted Supervisor 的工作身份由两份**互不相同**的事实组成：
 *
 * - **进程实例 id**：按一次进程启动生成一个 UUID，仅用于诊断与"这次到底是哪个进程"的
 *   可读归属。它**不**参与唯一性判定 —— 用 PID/hostname/时间戳当唯一值正是被修复的缺陷：
 *   不同容器里两个进程的 PID 可以相同，容器重启后 PID 也会重用。
 * - **claim id**：每次实际领取另生一个 UUID。它决定"是哪一次领取"，与 Ownership 代际一起
 *   构成排他依据（见 `runtime-session-store` 的 Supervisor claim）。
 *
 * 复用规则：模块被重复装载（测试里的 `vi.resetModules()`、打包器分包）时，同一次进程启动
 * 内必须是**同一个**实例 id —— 否则"实例 id 仅诊断"就退化成"每次装载都换一个诊断身份"，
 * 让日志与持久归属对不上。因此持有者挂在 `globalThis` 的 `Symbol.for(...)` 键上，
 * 不随模块图重新求值。
 */

const INSTANCE_KEY = Symbol.for("snowharness.worker-instance-identity.v1");

interface IdentityHolder {
  readonly instanceId: string;
}

function identityHolder(): IdentityHolder {
  const scope = globalThis as unknown as Record<symbol, IdentityHolder | undefined>;
  const existing = scope[INSTANCE_KEY];
  if (existing) return existing;
  const created: IdentityHolder = { instanceId: `worker-instance:${crypto.randomUUID()}` };
  scope[INSTANCE_KEY] = created;
  return created;
}

/** 本次进程启动的实例 id（诊断用；模块重复装载后仍相同）。 */
export function workerInstanceId(): string {
  return identityHolder().instanceId;
}

/**
 * 一次真实领取的 claim id。
 *
 * 每次调用都新生成 —— 这就是"每次实际领取另生 claim UUID"的唯一实现，
 * 调用方不得用实例 id、PID 或时间戳替代它。
 */
export function newSupervisorClaimId(): string {
  return crypto.randomUUID();
}
