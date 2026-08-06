/**
 * 进程树操作——取直接子进程的三级回退实现。
 *
 * 从 execution-runtime.ts 抽出,使三级回退(pgrep → /proc → ps)可独立 mock 测试,
 * 不牵连 execution-runtime 的 config/workspace/container 等顶层依赖。
 *
 * 零依赖(仅 execa 动态 import + node:fs/promises + process.platform),纯函数语义。
 */

/** 取 pid 的直接子进程，pgrep → /proc/.../children → ps 三级回退。 */
export async function directChildren(pid: number): Promise<number[]> {
 const { execa } = await import("execa");
 // 1. pgrep -P
 try {
 const r = await execa("pgrep", ["-P", String(pid)], { reject: false, timeout: 2_000 });
 if (r.exitCode === 0) {
 return r.stdout
 .split("\n")
 .map((l) => Number.parseInt(l.trim(), 10))
 .filter((n) => Number.isFinite(n));
 }
 } catch {
 // pgrep 不存在，走回退
 }
 // 2. Linux /proc/{pid}/task/{pid}/children
 if (process.platform === "linux") {
 try {
 const { readFile } = await import("node:fs/promises");
 const content = await readFile(`/proc/${pid}/task/${pid}/children`, "utf8");
 return content
 .trim()
 .split(/\s+/)
 .filter(Boolean)
 .map((n) => Number.parseInt(n, 10))
 .filter((n) => Number.isFinite(n));
 } catch {
 // /proc 不可读，走 ps 回退
 }
 }
 // 3. ps -o pid= -P（BSD/macOS 兼容）
 try {
 const r = await execa("ps", ["-o", "pid=", "-P", String(pid)], {
 reject: false,
 timeout: 2_000,
 });
 if (r.exitCode === 0) {
 return r.stdout
 .split("\n")
 .map((l) => Number.parseInt(l.trim(), 10))
 .filter((n) => Number.isFinite(n));
 }
 } catch {
 // 全部回退失败 → 返回空（best-effort）
 }
 return [];
}

/** pid 是否存活（process.kill 探活，0 信号不实际发信号）。 */
export function isAlive(pid: number): boolean {
 try {
 process.kill(pid, 0);
 return true;
 } catch {
 return false;
 }
}
