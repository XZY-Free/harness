import { type RuntimeType, runtimeConfig } from "@/lib/config";

/**
 * 纯配置解析层：按优先级解析线程应使用的 runtimeType。
 *
 * 优先级（plan ）：thread.runtimeType → skill_version.runtimeType → 全局默认。
 * 非法值跳过，最终回退 host。
 *
 * 本文件刻意不依赖 preview-runtime / execution-runtime，供 app route 顶层静态 import，
 * 避免 Next.js 构建 trace 把 preview-runtime 及其依赖 trace 进 server bundle。
 */
export function resolveRuntimeTypeForThread(
  thread: { runtimeType?: string | null } | null | undefined,
  skillVersion: { runtimeType?: string | null } | null | undefined,
): RuntimeType {
  const candidates = [thread?.runtimeType, skillVersion?.runtimeType, runtimeConfig.defaultType];
  for (const c of candidates) {
    if (c === "host" || c === "container") return c;
  }
  return "host";
}
