/**
 * / 4-4：全局 policy 配置。
 *
 * P4-1 原是模块级内存变量（含函数成员 detect）。P4-4 DB 化：
 * - 运行时 `PolicyConfig` 形状不变（protectedPaths 仍是 RegExp[]、verifyBeforeDelivery 仍含 detect 闭包），
 * **对 hooks 的接口零回归**（getPolicyConfig 仍同步返回 PolicyConfig）。
 * - DB 存纯数据（正则源 string + testFilePattern string），由 `lib/policy/interpreter.ts` 编译。
 * - getPolicyConfig：测试态 / setPolicyConfig 注入 → 返回内存值；否则返回启动时从 DB 刷新的缓存。
 *
 * **默认值原则（§7 头号风险）**：默认必须宽松到不破坏现有生成流程——
 * 正常 workspace 文件可写、正常命令可跑、无测试的静态站点不被验证卡住交付。
 *
 * policy 与 allowedTools 正交（§7）：allowedTools 控「工具可见性」（粗粒度），
 * policy 控「工具内行为」（细粒度），两者互补不重叠。
 */
import { appConfig } from "@/lib/config";
import { db } from "@/lib/db/client";
import { policyConfig } from "@/lib/db/schema";
import { logger } from "@/lib/logger";
import { interpretPolicyConfig } from "@/lib/policy/interpreter";

export type PolicyConfig = {
 /** 被禁写的相对路径模式（workspace 内；workspace 外已由 safeJoin 防越界）。 */
 protectedPaths: RegExp[];
 /** 高危命令模式（仅毁灭性，不挡 npm/build）。 */
 commandDenyList: RegExp[];
 /** 写后自动格式化（best-effort，fail-open）。command 为空则 no-op。 */
 formatOnWrite: {
 enabled: boolean;
 command: string;
 };
 /** 交付前必跑验证：仅当 detect 命中可验证项才跑；未过 fail-closed。 */
 verifyBeforeDelivery: {
 enabled: boolean;
 /** 检测工作区是否存在可验证项（如有测试文件）；命中才跑验证命令。 */
 detect: (files: string[]) => boolean;
 command: string;
 timeoutMs: number;
 /** 超时是否算失败（默认 false=放行，避免长测试卡死交付，§7）。 */
 timeoutIsFailure: boolean;
 /**
 * e2e 测试文件 pattern（detect 命中 e2e 时跳过验证——e2e 慢，交付前只跑 unit）。
 * 默认匹配 e2e/integration 目录或 .e2e.test. 后缀。
 */
 e2eTestPattern?: RegExp;
 };
};

/**
 * 默认 testFilePattern（单正则，合并测试目录 + 测试文件后缀）——
 * 与 P4-1 双模式 detect 行为等价（A||B ≡ A|B），但可序列化为 string 存 DB。
 * 仅当存在真实测试才视为「有可验证项」（纯静态站点跳过验证）。
 */
export const DEFAULT_TEST_FILE_PATTERN =
 /(^|\/)(__tests__|tests?|spec)\/|\.(test|spec)\.[cm]?[jt]sx?$/;
export const DEFAULT_TEST_FILE_PATTERN_SOURCE = DEFAULT_TEST_FILE_PATTERN.source;

/** 由 testFilePattern 重建 detect 闭包（interpreter 与默认值共用）。 */
export function makeTestFileDetect(
 pattern: RegExp,
 e2ePattern?: RegExp,
): (files: string[]) => boolean {
 return (files: string[]) => {
 const testFiles = files.filter((f) => pattern.test(f));
 if (testFiles.length === 0) return false;
 // 排除 e2e 测试文件——交付前只跑 unit
 if (e2ePattern) return testFiles.some((f) => !e2ePattern.test(f));
 return true;
 };
}

/**
 * 默认 policy 的 DB 行表示（纯数据：正则源 string + testFilePattern string）。
 * seed 与 migration backfill 的单一真值来源；detect 闭包不进入此序列化。
 * 与 interpretPolicyConfig 互为逆运算（见 config.test round-trip）。
 */
export function defaultPolicyRows(): { key: string; value: unknown }[] {
 const v = defaultPolicyConfig.verifyBeforeDelivery;
 return [
 { key: "protectedPaths", value: defaultPolicyConfig.protectedPaths.map((r) => r.source) },
 { key: "commandDenyList", value: defaultPolicyConfig.commandDenyList.map((r) => r.source) },
 { key: "formatOnWrite", value: defaultPolicyConfig.formatOnWrite },
 {
 key: "verifyBeforeDelivery",
 value: {
 enabled: v.enabled,
 command: v.command,
 timeoutMs: v.timeoutMs,
 timeoutIsFailure: v.timeoutIsFailure,
 testFilePattern: DEFAULT_TEST_FILE_PATTERN_SOURCE,
 },
 },
 ];
}

/**
 * 默认宽松 policy。
 *
 * - protectedPaths：仅 `.git/`（workspace 外已由 safeJoin 防）。
 * - commandDenyList：仅毁灭性——rm -rf 绝对/家目录、fork bomb、mkfs/dd 直写块设备。
 * 故意不挡 `rm -rf node_modules` / `rm -rf dist` 等 workspace 内正常清理。
 * - formatOnWrite：默认 `npx --no-install prettier`（best-effort；prettier 缺失/失败 fail-open，不阻断写入、不触发下载）。
 * - verifyBeforeDelivery：默认启用，但仅当检测到测试文件才跑 `npm test`；
 * 无测试的静态站点跳过验证（不卡交付）；超时默认放行。
 */
export const defaultPolicyConfig: PolicyConfig = {
 protectedPaths: [/^\.git(\/|$)/],
 commandDenyList: [
 // rm -rf 指向根目录 / 家目录（绝对路径）——不挡 workspace 内相对路径清理
 /\brm\s+-[a-z]*r[a-z]*f?\s+(\/|~)/,
 // 经典 fork bomb：:(){ :|:& };:
 /:\s*\(\)\s*\{\s*:\s*\|\s*:\s*&\s*\}\s*;\s*:/,
 // 格式化磁盘 / dd 直写块设备
 /\bmkfs\.\w+\b/,
 /\bdd\b[^|]*\bof=\/dev\//,
 ],
 formatOnWrite: {
 enabled: true,
 // npx --no-install：优先用 workspace/环境已装的 prettier；缺失则非零退出 → fail-open
 // 跳过（绝不触发网络下载，避免在写入热路径上卡顿）。路径经 hooks.shellQuote 转义后拼接。
 command: "npx --no-install prettier --write",
 },
 verifyBeforeDelivery: {
 enabled: true,
 detect: makeTestFileDetect(
 DEFAULT_TEST_FILE_PATTERN,
 /(^|\/)(e2e|integration)\b|\.(e2e|integration)\.(test|spec)\./,
 ),
 command: "npm test",
 timeoutMs: 60_000,
 timeoutIsFailure: false,
 // e2e 测试 pattern——detect 命中 e2e 时不算「有可验证项」（e2e 慢，交付前只跑 unit）
 e2eTestPattern: /(^|\/)(e2e|integration)\b|\.(e2e|integration)\.(test|spec)\./,
 },
};

// override：setPolicyConfig 注入（测试态）。cached：从 DB 刷新的运行时配置（启动时载入）。
let override: PolicyConfig | null = null;
let cached: PolicyConfig = defaultPolicyConfig;
// TTL 刷新时间戳。多实例部署下其他实例改 policy 后，本实例在 TTL 内自动刷新。
let cachedAt = 0;
const POLICY_TTL_MS = 60_000; // 60s TTL

/**
 * 读取当前生效 policy（hooks 同步调用，接口不变）。
 * - override 已注入 → 返回 override（测试覆盖）。
 * - 否则返回 cached。超 TTL 时标记 stale（异步刷新，不阻塞同步返回）。
 */
export function getPolicyConfig(): PolicyConfig {
 if (override) return override;
 // TTL 到期 → 异步刷新（不阻塞同步调用，下次调用读到新值）
 if (Date.now() - cachedAt > POLICY_TTL_MS) {
 void refreshPolicyConfigFromDB().catch(() => {});
 }
 return cached;
}

/** 覆盖 policy（仅测试用；优先级高于 DB 缓存）。 */
export function setPolicyConfig(config: PolicyConfig): void {
 override = config;
}

/** 清除测试覆盖（测试间隔离；不动 cached，测试态 cached 始终是 defaultPolicyConfig）。 */
export function resetPolicyConfig(): void {
 override = null;
}

/**
 * 从 DB 读取并解释 policy（纯数据访问，不做 isTest 守卫，便于单测 mock db）。
 * DB 空 → defaultPolicyConfig。
 */
export async function loadPolicyConfigFromDB(): Promise<PolicyConfig> {
 const rows = await db.select().from(policyConfig);
 return rows.length === 0 ? defaultPolicyConfig : interpretPolicyConfig(rows);
}

/**
 * 从 DB 刷新 policy 缓存（启动时由 instrumentation 调用；policy 编辑后可再调）。
 * - 测试态跳过（测试用 setPolicyConfig / defaultPolicyConfig，不走 DB，零回归）。
 * - DB 空 / 读取异常 → fail-open 沿用 defaultPolicyConfig（policy 是治理便利，不是治理目的，）。
 */
export async function refreshPolicyConfigFromDB(): Promise<void> {
 if (appConfig.isTest) return;
 try {
 cached = await loadPolicyConfigFromDB();
 cachedAt = Date.now(); // 更新刷新时间戳
 } catch (error) {
 logger.warn("policy DB 加载失败，沿用默认（fail-open）", {
 error: error instanceof Error ? error.message : String(error),
 });
 cached = defaultPolicyConfig;
 cachedAt = Date.now();
 }
}
