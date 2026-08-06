import { hostSandboxConfig } from "@/lib/config";
import { logger } from "@/lib/logger";

/**
 * host exec 沙箱（Linux bubblewrap）。
 *
 * 原实现 host exec 仅 `cwd: workspaceRoot`，shell 可 `cd /` 读写任意路径（无文件系统隔离）。
 * 本模块用 `bwrap`（bubblewrap，Linux 用户态命名空间沙箱，无需 root）包裹命令：
 * - workspace 绑定 RW（命令可读写工作区）
 * - /usr /lib /lib64 /bin /sbin /etc 只读绑定（node/npm/系统工具可用）
 * - /dev /proc 挂载，/tmp /run tmpfs（隔离临时文件）
 * - 不绑定 /home（防读 ~/.ssh ~/.npmrc 等宿主凭证）
 * - --unshare-all + --share-net（隔离 IPC/PID/mount/uts，保留网络供 npm install）
 *
 * 默认 OFF（host 模式为开发信任环境，且 bwrap 配置对任意命令并非 100% 兼容）。运维经
 * `SNOW_HOST_SANDBOX=on` 显式开启硬隔离；`auto` = bwrap 可用则开启。bwrap 不可用时 fail-open
 * （warn 日志，原样执行），不阻断开发流程。
 */

let bwrapAvailable: boolean | null = null;

/** 探测 bwrap 是否可用（缓存，进程生命周期内只探一次）。 */
async function detectBwrap(): Promise<boolean> {
 if (bwrapAvailable !== null) return bwrapAvailable;
 if (process.platform !== "linux") {
 bwrapAvailable = false;
 return false;
 }
 try {
 const { execa } = await import("execa");
 const r = await execa("bwrap", ["--version"], { reject: false, timeout: 3_000 });
 bwrapAvailable = r.exitCode === 0;
 } catch {
 bwrapAvailable = false;
 }
 return bwrapAvailable;
}

/** 最小 shell 单引号转义。 */
function shQuote(s: string): string {
 return `'${s.replace(/'/g, "'\\''")}'`;
}

/**
 * 用 bwrap 包裹 host 命令施加文件系统隔离。
 *
 * 产物形如 `bwrap --ro-bind /usr /usr ... --bind <workspace> <workspace> --cwd <workspace> -- sh -c '<command>'`。
 * 配合 execa shell:true（外层 sh 启动 bwrap，bwrap exec 内层 sh 解析原命令）。
 *
 * 沙箱未启用 / 非 Linux / bwrap 不可用 → 原样返回（不伪装有沙箱）。
 */
export async function wrapWithHostSandbox(command: string, cwd: string): Promise<string> {
 const mode = hostSandboxConfig.mode;
 if (mode === "off") return command;
 if (process.platform !== "linux") return command;
 const available = await detectBwrap();
 if (!available) {
 // 审计修复 M1：mode=on 时运维显式要求沙箱，bwrap 不可用须告警（原代码静默 fail-open，
 // 运维无从知晓命令在无隔离环境下执行）。mode=auto 静默回落（预期行为）。
 if (mode === "on") {
 logger.warn("host sandbox mode=on 但 bwrap 不可用，命令将在无沙箱隔离下执行", {
 cwd,
 hint: "安装 bubblewrap (apt install bubblewrap) 或切换 SNOW_HOST_SANDBOX=off",
 });
 }
 return command;
 }

 // 系统只读绑定（部分目录不存在时 bwrap 报错，用 --ro-bind-try 容错）
 const roBinds = ["/usr", "/lib", "/lib64", "/bin", "/sbin", "/etc", "/var", "/opt", "/nix"];
 const args: string[] = ["bwrap", "--die-with-parent", "--unshare-all", "--share-net"];
 for (const b of roBinds) {
 args.push("--ro-bind-try", b, b);
 }
 args.push("--dev", "/dev", "--proc", "/proc", "--tmpfs", "/tmp", "--tmpfs", "/run");
 // workspace 绑定 RW（命令的工作目录）
 // 审计修复 M1：cwd 用 shQuote 包裹（原 args.join(" ") 裸拼路径，含空格的路径会导致
 // bwrap --bind / --cwd 参数被 shell 拆分，挂载错误目录或静默失败）。
 args.push("--bind", shQuote(cwd), shQuote(cwd));
 args.push("--cwd", shQuote(cwd));
 // 用 execa shell:true 跑整个 bwrap 命令串：sh -c "bwrap ... -- sh -c '<command>'"
 // bwrap 的 args 含路径，整体作为一个 shell 命令串；用 shQuote 包裹内层 command。
 // 构造：bwrap <args...> sh -c '<command>'
 const inner = `sh -c ${shQuote(command)}`;
 return `${args.join(" ")} ${inner}`;
}

/** 仅供测试：重置 bwrap 探测缓存。 */
export function __resetSandboxCacheForTest(): void {
 bwrapAvailable = null;
}
