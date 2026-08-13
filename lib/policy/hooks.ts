import { logger } from "@/lib/logger";
/**
 * ：hook 引擎——挂载在 的统一工具入口（executeToolRun）与交付闸门
 * （reportThreadReady），把「禁写受保护目录、高危命令拦截、写后格式化、交付前验证」
 * 从 prompt 自觉变成确定性治理（蓝图 §10）。
 *
 * 结构（）：
 * - **判定纯函数**（decideWrite/decideCommand/beforeTool）：路径 / 命令匹配，可单测。
 * - **副作用函数**（runFormatOnWrite/runVerifyBeforeDelivery）：跑 formatter / 验证命令，
 * 经 lib/policy/exec 的独立 seam 执行，与 agent 工具执行分离。
 *
 * fail-open / fail-closed 边界（，两类不可混淆）：
 * - hook 引擎自身异常、格式化失败 → **fail-open**（放行 + 记日志，绝不锁死主链路）。
 * - 受保护路径、命令黑名单、交付前验证未过 → **fail-closed**（明确拦截，治理目的）。
 */
import { type PolicyConfig, getPolicyConfig } from "@/lib/policy/config";
import { runWorkspaceCommand } from "@/lib/policy/exec";
import { listWorkspaceFiles } from "@/lib/workspace";

export type HookTiming = "beforeTool" | "afterTool" | "beforeDelivery";

export type PolicyDecision = { allow: true } | { allow: false; reason: string };

/** 判定写入是否被禁（纯函数）：匹配受保护路径模式。workspace 外已由 safeJoin 防。 */
export function decideWrite(
  relPath: string,
  config: PolicyConfig = getPolicyConfig(),
): PolicyDecision {
  const normalized = relPath.replace(/^\.?\//, "");
  for (const re of config.protectedPaths) {
    if (re.test(relPath) || re.test(normalized)) {
      return { allow: false, reason: `受保护路径：${relPath}` };
    }
  }
  return { allow: true };
}

/** 判定命令是否被禁（纯函数）：匹配高危命令黑名单。 */
export function decideCommand(
  command: string,
  config: PolicyConfig = getPolicyConfig(),
): PolicyDecision {
  for (const re of config.commandDenyList) {
    if (re.test(command)) {
      return { allow: false, reason: `高风险命令：${command}` };
    }
  }
  return { allow: true };
}

/**
 * beforeTool 判定（纯函数分发）：按工具名把 input 路由到对应判定。
 * 仅 writeFile（路径）/ runCommand（命令）受 policy 约束，其余放行。
 *
 * @deprecated P2 清理(07 Permission P2-1): executeToolRun 已改用 evaluatePermission
 * (allow/deny/ask 三态),本函数为 deny-only 薄包装,无生产调用方(仅 hooks.test.ts 等价性校验)。
 * 保留是为了向后兼容(export 公共 API)与 decideWrite/decideCommand 等价性测试。
 * 新代码不应调用本函数,直接用 evaluatePermission。
 * 后续大版本可移除(需同步清理测试)。
 */
export function beforeTool(
  toolName: string,
  input: Record<string, unknown>,
  config: PolicyConfig = getPolicyConfig(),
): PolicyDecision {
  if (toolName === "writeFile") {
    return decideWrite(String(input.path ?? ""), config);
  }
  if (toolName === "runCommand") {
    return decideCommand(String(input.command ?? ""), config);
  }
  return { allow: true };
}

/**
 * POSIX shell 单引号转义：把不可信路径安全嵌入 `shell:true` 执行的命令字符串。
 *
 * formatOnWrite 把 relPath 拼进经 shell 执行的命令（lib/policy/exec）。relPath 虽经
 * safeJoin 防越界，但**不防文件名内的 shell 元字符**（如 `a.js;rm -rf x`、`$(…)`、反引号）。
 * 治理层自身不能成为注入面，故路径一律单引号包裹——单引号内除单引号外皆字面量，
 * 遇单引号则「闭合 → 转义单引号 → 重开」（`'\''`）。
 */
export function shellQuote(arg: string): string {
  return `'${arg.replace(/'/g, `'\\''`)}'`;
}

/**
 * afterTool 副作用：写后自动格式化（best-effort，**fail-open**）。
 *
 * 失败（非零退出 / 异常）只记日志，绝不阻断 writeFile 的成功返回——格式化是治理便利，
 * 不是治理目的（）。command 为空则 no-op（未配置 formatter）。
 */
// formatter 可用性缓存。首次失败（npx 退出非零，如 workspace 无 prettier）后
// 置 false，后续 writeFile 跳过 formatOnWrite，避免每次 fork npx 浪费。进程级缓存，重启重置。
let formatterAvailable = true;

export async function runFormatOnWrite(
  threadId: string,
  relPath: string,
  config: PolicyConfig = getPolicyConfig(),
): Promise<void> {
  if (!config.formatOnWrite.enabled || !config.formatOnWrite.command.trim()) return;
  // formatter 不可用则跳过（避免每次写入 fork npx 失败的性能损耗）
  if (!formatterAvailable) return;
  // P2 修复(07 Permission P2-6): formatOnWrite.command 白名单校验。
  // command 来自 DB policy(管理员配置),若含恶意命令(如 `prettier; rm -rf /`)会注入。
  // 虽 admin 本身高权限,但纵深防御应校验。仅允许已知 formatter 工具前缀。
  const ALLOWED_FORMATTER_PREFIXES = [
    "npx --no-install prettier",
    "npx prettier",
    "prettier",
    "npx --no-install biome",
    "npx biome",
    "biome",
    "npx --no-install eslint",
    "npx eslint",
    "eslint",
  ];
  const cmd = config.formatOnWrite.command.trim();
  // 同类:拒 shell 元字符,防 `prettier --write x && rm -rf /` 链式注入
  const noMetachar = !/[;&|$\n`\\]/.test(cmd);
  const isAllowed =
    noMetachar && ALLOWED_FORMATTER_PREFIXES.some((p) => cmd === p || cmd.startsWith(`${p} `));
  if (!isAllowed) {
    logger.warn("formatOnWrite command 不在白名单（fail-open 跳过）", {
      threadId,
      command: cmd,
    });
    return;
  }
  try {
    const result = await runWorkspaceCommand(
      threadId,
      `${config.formatOnWrite.command} ${shellQuote(relPath)}`,
      { timeoutMs: 30_000 },
    );
    if (result.exitCode !== 0) {
      // formatter 不可用（如 ENOENT 127 / prettier 未装）→ 缓存 false，后续跳过
      if (result.exitCode === 127 || /not found|enoent/i.test(result.stderr)) {
        formatterAvailable = false;
        logger.warn("formatOnWrite formatter 不可用，后续写入跳过（进程级缓存，重启重置）", {
          threadId,
          command: cmd,
        });
      } else {
        logger.warn("formatOnWrite 非零退出（fail-open）", {
          threadId,
          relPath,
          exitCode: result.exitCode,
          stderr: result.stderr.slice(0, 500),
        });
      }
    }
  } catch (error) {
    // spawn ENOENT → formatter 不可用，缓存 false
    const msg = error instanceof Error ? error.message : String(error);
    if (/enoent|not found/i.test(msg)) {
      formatterAvailable = false;
      logger.warn("formatOnWrite formatter 不可用（spawn ENOENT），后续跳过", {
        threadId,
        command: cmd,
      });
    } else {
      logger.warn("formatOnWrite 异常（fail-open）", { threadId, relPath, error: msg });
    }
  }
}

/** 仅供测试：重置 formatter 可用性缓存。 */
export function __resetFormatterAvailableForTest(): void {
  formatterAvailable = true;
}

/**
 * beforeDelivery 副作用：交付前必跑验证（**fail-closed** on 未过/执行异常）。
 *
 * 流程（）：
 * 1. 未启用 → 放行。
 * 2. 工作区无可验证项（detect 未命中，如纯静态站点）→ 跳过验证，放行（不卡交付）。
 * 3. 跑验证命令：exit 0 放行；非零 → 拦截（reason 带输出摘要）。
 * 4. 超时按 config.timeoutIsFailure 处理。
 * 5. 工作区枚举/命令启动异常 → fail-closed（验证基础设施不可用时，不能伪装已验证）。
 */
/**
 * : verifyBeforeDelivery.command 白名单(纯函数,可单测)。
 * command 来自 DB policy(管理员配置),shell:true 执行;无白名单则 admin 可配任意命令
 * (如 `npm test; curl evil.com`)。仅允许已知测试/构建/lint 命令前缀。
 */
const ALLOWED_VERIFY_PREFIXES = [
  "npm test",
  "npm run test",
  "pnpm test",
  "pnpm run test",
  "yarn test",
  "yarn run test",
  "npx vitest run",
  "npx vitest",
  "vitest run",
  "vitest",
  "npm run build",
  "pnpm run build",
  "yarn run build",
  "npm run lint",
  "pnpm run lint",
  "yarn run lint",
];

export function isAllowedVerifyCommand(command: string): boolean {
  const cmd = command.trim();
  // 拒绝 shell 元字符:防 `npm test && rm -rf /` / `npm test; curl evil` 等链式注入。
  // 测试/构建/lint 的合法参数不需这些字符。
  if (/[;&|$\n`\\]/.test(cmd)) return false;
  return ALLOWED_VERIFY_PREFIXES.some((p) => cmd === p || cmd.startsWith(`${p} `));
}

export async function runVerifyBeforeDelivery(
  threadId: string,
  config: PolicyConfig = getPolicyConfig(),
): Promise<PolicyDecision> {
  if (!config.verifyBeforeDelivery.enabled) return { allow: true };
  let files: string[];
  try {
    files = await listWorkspaceFiles(threadId);
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    logger.error("交付前验证前置检查失败（fail-closed）", {
      threadId,
      error: message,
    });
    return { allow: false, reason: `无法枚举工作区文件：${message}` };
  }

  let shouldVerify = false;
  try {
    shouldVerify = config.verifyBeforeDelivery.detect(files);
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    logger.error("交付前验证 detect 异常（fail-closed）", {
      threadId,
      error: message,
    });
    return { allow: false, reason: `验证检测失败：${message}` };
  }
  if (!shouldVerify) return { allow: true };

  // : verifyBeforeDelivery.command 白名单校验(与 formatOnWrite 对齐)。
  if (!isAllowedVerifyCommand(config.verifyBeforeDelivery.command)) {
    logger.warn("verifyBeforeDelivery command 不在白名单（fail-closed 拒绝交付）", {
      threadId,
      command: config.verifyBeforeDelivery.command.trim(),
    });
    return {
      allow: false,
      reason: `交付前验证命令不在白名单：${config.verifyBeforeDelivery.command.trim()}`,
    };
  }

  let result: Awaited<ReturnType<typeof runWorkspaceCommand>>;
  try {
    result = await runWorkspaceCommand(threadId, config.verifyBeforeDelivery.command, {
      timeoutMs: config.verifyBeforeDelivery.timeoutMs,
    });
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    logger.error("交付前验证执行异常（fail-closed）", {
      threadId,
      error: message,
    });
    return { allow: false, reason: `交付前验证执行失败：${message}` };
  }

  if (result.timedOut) {
    if (config.verifyBeforeDelivery.timeoutIsFailure) {
      return { allow: false, reason: "交付前验证超时" };
    }
    logger.warn("交付前验证超时（按配置放行）", { threadId });
    return { allow: true };
  }
  if (result.exitCode === 0) return { allow: true };
  const detail = (result.stderr || result.stdout).slice(0, 500);
  return { allow: false, reason: `验证未过（exit ${result.exitCode}）：${detail}` };
}
