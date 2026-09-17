/**
 * Session 写入的测试夹具入口（R02 §8）。
 *
 * 生产侧 Session 写入必须是「调用方事务 + 行锁 + 版本 CAS」的仓储方法；
 * 夹具不应各自复制事务样板，也不应绕过仓储。这里只做「开事务 → 调用生产仓储方法」，
 * 并把行版本显式传给 CAS，不引入任何测试专用写路径。
 */
import { db } from "@/lib/db/client";
import type { RuntimeSessionBinding } from "@/lib/persistence/schema/executions";
import {
  type CreateRuntimeSessionBindingInput,
  type RuntimeSessionDispatchPatch,
  createRuntimeSessionBindingInTransaction,
  lockRuntimeSessionBindingInTransaction,
  updateRuntimeSessionDispatchInTransaction,
} from "@/lib/runtime/persistence/runtime-session-store";

export async function createRuntimeSessionBindingForTest(
  input: CreateRuntimeSessionBindingInput,
): Promise<RuntimeSessionBinding> {
  return db.transaction((tx) => createRuntimeSessionBindingInTransaction(tx, input));
}

/** 与生产同名写入等价：锁 Session 行 → 用当前行版本 CAS → 走单向转换表。 */
export async function applyRuntimeSessionDispatchForTest(
  tenantId: string,
  sessionBindingId: string,
  patch: RuntimeSessionDispatchPatch,
): Promise<RuntimeSessionBinding> {
  return db.transaction(async (tx) => {
    const current = await lockRuntimeSessionBindingInTransaction(tx, tenantId, sessionBindingId);
    return updateRuntimeSessionDispatchInTransaction(tx, {
      tenantId,
      id: sessionBindingId,
      expectedVersionNo: current.versionNo,
      patch,
    });
  });
}
