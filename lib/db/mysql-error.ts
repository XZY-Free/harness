/**
 * 共享、纯逻辑、与 Drizzle 版本解耦的 MySQL 错误判定边界。
 *
 * 背景：drizzle-orm 0.45 起把 mysql2 的 ER_DUP_ENTRY 放进错误对象的 cause 链，
 * 只检查顶层 code/errno 会漏判 Drizzle 包装后的唯一约束冲突。本函数沿
 * error → error.cause 链迭代判定，任一层命中即返回 true。
 */

/**
 * 判断未知错误是否表示 MySQL 唯一约束冲突（ER_DUP_ENTRY / errno 1062）。
 *
 * - 沿 error.cause 链逐层检查（迭代实现，避免深层 cause 导致栈溢出）。
 * - 任一层 code === "ER_DUP_ENTRY" 或 errno === 1062 即返回 true。
 * - 非对象输入（null / primitive）返回 false。
 * - 用 Set 记录已访问对象引用，自引用 / 任意循环 cause 有限终止且不误判。
 * - 属性读取异常时 fail-closed，不把未知错误当作重复键。
 */
export function isMysqlDuplicateEntryError(error: unknown): boolean {
  const seen = new Set<object>();
  let current: unknown = error;

  while (typeof current === "object" && current !== null) {
    if (seen.has(current)) break;
    seen.add(current);

    let code: unknown;
    let errno: unknown;
    let cause: unknown;
    try {
      const e = current as { code?: unknown; errno?: unknown; cause?: unknown };
      code = e.code;
      errno = e.errno;
      cause = e.cause;
    } catch {
      // fail-closed：读不到字段就不当作重复键。
      return false;
    }

    if (code === "ER_DUP_ENTRY" || errno === 1062) return true;
    current = cause;
  }

  return false;
}

/**
 * A07 决策四：判断未知错误是否为「可安全重试整个事务」的并发冲突。
 *
 * 与 `isMysqlDuplicateEntryError` 分开命名，是因为调用方的语义完全不同：
 * 唯一键冲突在"插入首代 scope 行"的路径上意味着**另一个事务已经建立了同一 scope**，
 * 死锁/锁等待超时意味着两个事务以不同顺序取了同一批锁。两者都只能用同一种方式收口：
 * 回滚**整个**预留事务、重新读取当前行，再基于新读到的状态重新决策。
 * 绝不允许把它们降级成 `ON DUPLICATE KEY UPDATE` 之类的覆盖写 —— 那会把另一方的
 * holder/generation 改写成自己，正是 A07-05/06 要消灭的行为。
 *
 * 沿 `error.cause` 链判定（与重复键判定同构），属性读取异常时 fail-closed。
 */
export function isMysqlTransactionContentionError(error: unknown): boolean {
  const seen = new Set<object>();
  let current: unknown = error;

  while (typeof current === "object" && current !== null) {
    if (seen.has(current)) break;
    seen.add(current);

    let code: unknown;
    let errno: unknown;
    let cause: unknown;
    try {
      const e = current as { code?: unknown; errno?: unknown; cause?: unknown };
      code = e.code;
      errno = e.errno;
      cause = e.cause;
    } catch {
      return false;
    }

    if (code === "ER_DUP_ENTRY" || errno === 1062) return true;
    // ER_LOCK_DEADLOCK / ER_LOCK_WAIT_TIMEOUT：MySQL 已回滚事务，重试是唯一正确处置。
    if (code === "ER_LOCK_DEADLOCK" || errno === 1213) return true;
    if (code === "ER_LOCK_WAIT_TIMEOUT" || errno === 1205) return true;
    current = cause;
  }

  return false;
}
