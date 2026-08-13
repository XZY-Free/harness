/**
 * 自定义工具 script executor 白名单（蓝图 ）。
 *
 * **只跑平台预置脚本**——非白名单 scriptId 拒绝，绝不执行用户提供的任意代码（命门 #2）。
 * 新增脚本须在此显式登记并实现 run(args)，不可由用户配置注入任意 scriptId/代码。
 */

export type ScriptRunner = (
  args: Record<string, unknown>,
) => Promise<{ ok: true; content: unknown } | { ok: false; error: string }>;

const SCRIPTS = new Map<string, ScriptRunner>();

/** 注册一个平台预置脚本（启动时登记）。 */
function register(scriptId: string, runner: ScriptRunner): void {
  SCRIPTS.set(scriptId, runner);
}

// ─── 平台预置脚本 ─────────────────────────────────────────
// echo：回显参数（最小可用示例，供测试与冒烟）
register("echo", async (args) => ({ ok: true, content: args }));
// noop：空操作，返回 ok
register("noop", async () => ({ ok: true, content: null }));

/** 白名单条目（供 parseDeclaration 校验与 Studio 展示）。 */
export const SCRIPT_WHITELIST: ReadonlyMap<string, ScriptRunner> = SCRIPTS;

/** 运行白名单脚本；非白名单 scriptId 拒绝。 */
export async function runWhitelistedScript(
  scriptId: string,
  args: Record<string, unknown>,
): Promise<{ ok: true; content: unknown } | { ok: false; error: string }> {
  const runner = SCRIPTS.get(scriptId);
  if (!runner) return { ok: false, error: `script scriptId 不在白名单: ${scriptId}` };
  try {
    return await runner(args);
  } catch (e) {
    return { ok: false, error: e instanceof Error ? e.message : String(e) };
  }
}
