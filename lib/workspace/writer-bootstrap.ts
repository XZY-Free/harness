/**
 * A07 决策三：受管 Writer 的**启动屏障**（wrapper 侧）。
 *
 * 仅把 `phase = spawning` 写在 spawn 之前是不够的：从 `spawn` 返回到"PID 落盘"之间
 * 仍有一个窗口，已启动的进程在那里没有任何可回收定位。本模块把用户任务挡在
 * **私有启动管道**之后，于是三个崩溃窗口都有确定结论：
 *
 * | Broker 崩溃时点 | 结果 |
 * | --- | --- |
 * | 登记前 | 管道关闭 → wrapper 收到 EOF → **用户 command 从未开始** |
 * | 登记后、GO 前 | 定位已持久 → 恢复器可真实终止它；用户 command 同样从未开始 |
 * | GO 后 | 实际运行处在已登记的 containment（wrapper 进程组）中 → 可停止并排空 |
 *
 * 这里的源码是**纯字符串**：它由 `node -e` 直接执行，因此不依赖仓库内的任何模块解析、
 * 也不受构建产物影响。wrapper 自身在收到 GO 之前不产生任何副作用。
 */

/** 私有启动通道的文件描述符（`spawn` 的 `stdio[3]`）。 */
export const WRITER_GO_CHANNEL_FD = 3;

/** 放行令牌格式：`GO <token>\n`。令牌不匹配时拒绝运行用户任务。 */
export const WRITER_GO_TOKEN_PREFIX = "GO";

export interface WriterBootstrapPayload {
  /** 用户实际要运行的可执行文件。 */
  command: string;
  args: string[];
  cwd: string;
  scopeDigest: string;
  writerGeneration: number;
  /** 本次启动一次性令牌：防止任何非本次放行的字节被当成 GO。 */
  goToken: string;
}

/**
 * 必须在收到与本次启动令牌匹配的 GO **之后**才运行用户 command。
 *
 * 退出码语义（供恢复器与日志区分崩溃窗口，不参与业务判定）：
 * - `0`：正常完成，或"未获放行"（用户任务从未开始）；
 * - `41`：启动通道不可用（无法建立屏障）→ 拒绝运行用户任务；
 * - `42`：放行令牌不匹配 → 拒绝运行用户任务。
 */
const BOOTSTRAP_SOURCE = [
  '"use strict";',
  'const fs = require("node:fs");',
  'const { spawn } = require("node:child_process");',
  `const GO_FD = ${WRITER_GO_CHANNEL_FD};`,
  'const TOKEN_PREFIX = "GO";',
  "let payload = null;",
  "try { payload = JSON.parse(process.argv[1]); } catch (error) { payload = null; }",
  'if (!payload || typeof payload.command !== "string" || !Array.isArray(payload.args)) {',
  "  process.exit(41);",
  "}",
  "/**",
  " * 等待放行：读到 `<TOKEN_PREFIX> <token>\\n` 才算放行；EOF/错误一律视为**未放行**。",
  " * 返回 released=false 表示未放行：调用方必须直接退出，绝不运行用户任务。",
  " */",
  "function waitForRelease() {",
  "  return new Promise((resolve) => {",
  '    let seen = "";',
  "    let settled = false;",
  "    let channel = null;",
  "    try {",
  '      channel = fs.createReadStream("", { fd: GO_FD });',
  "    } catch (error) {",
  "      resolve({ released: false, failed: true });",
  "      return;",
  "    }",
  "    const settle = (value) => {",
  "      if (settled) return;",
  "      settled = true;",
  "      try { channel.destroy(); } catch (error) {}",
  "      resolve(value);",
  "    };",
  '    channel.on("data", (chunk) => {',
  '      seen += chunk.toString("utf8");',
  '      const index = seen.indexOf("\\n");',
  "      if (index < 0) return;",
  "      const line = seen.slice(0, index).trim();",
  '      if (line === TOKEN_PREFIX + " " + payload.goToken) settle({ released: true });',
  "      else settle({ released: false, mismatched: true });",
  "    });",
  '    channel.on("end", () => settle({ released: false }));',
  '    channel.on("close", () => settle({ released: false }));',
  '    channel.on("error", () => settle({ released: false, failed: true }));',
  "  });",
  "}",
  "waitForRelease().then((outcome) => {",
  "  if (!outcome || !outcome.released) {",
  "    // 未获放行：用户 command 从未开始。不清理、不猜测，直接退出。",
  "    process.exit(outcome && outcome.mismatched ? 42 : outcome && outcome.failed ? 41 : 0);",
  "  }",
  "  // 关闭启动通道，避免用户 command 继承它（否则它会替 Broker 一直握着 GO 管道）。",
  "  try { fs.closeSync(GO_FD); } catch (error) {}",
  "  // wrapper 是进程组 leader：用户 command 留在同一进程组内，",
  "  // 因此 Broker 对进程组发信号即可同时覆盖两者。",
  "  const child = spawn(payload.command, payload.args, {",
  "    cwd: payload.cwd,",
  '    stdio: "inherit",',
  "    env: process.env,",
  "  });",
  '  child.on("error", () => process.exit(0));',
  '  child.on("exit", (code, signal) => process.exit(signal ? 0 : code || 0));',
  "});",
].join("\n");

/** 传递给 `node -e` 的脚本源码（与生产完全一致；测试也用它启动真实 wrapper）。 */
export function writerBootstrapSource(): string {
  return BOOTSTRAP_SOURCE;
}

/** `spawn(process.execPath, writerBootstrapArgv(payload), ...)` 的完整参数。 */
export function writerBootstrapArgv(payload: WriterBootstrapPayload): string[] {
  return ["-e", BOOTSTRAP_SOURCE, JSON.stringify(payload)];
}

/** 放行字节串：与 wrapper 的匹配规则严格对应。 */
export function writerGoBytes(payload: WriterBootstrapPayload): string {
  return `${WRITER_GO_TOKEN_PREFIX} ${payload.goToken}\n`;
}
