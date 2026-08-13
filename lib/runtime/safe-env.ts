/**
 * P1 修复（02 Runtime ）：Host exec 环境变量白名单过滤。
 *
 * 原实现 `env: { ...process.env, ...secretsCache }` 把平台进程的**全部** env 透传给
 * AI 执行的命令(runCommand/runBuild/installDependencies),含 DATABASE_URL/LLM_API_KEY/
 * 部署密钥等。AI 生成或被 prompt injection 诱导的命令可 `printenv DB_PASSWORD` 泄露平台 secret。
 *
 * 本模块提供 buildSafeEnv:从 process.env 过滤出命令执行所需的安全子集:
 * - 白名单前缀:PATH/HOME/USER/SHELL/TERM/TMPDIR/locale 等 base 变量 + NODE_OPTIONS、
 * NPM_CONFIG_xxx、PNPM_HOME 等 node/npm 生态变量(前端构建命令需要)
 * - 黑名单关键字兜底:即便白名单匹配,变量名含 SECRET/TOKEN/PASSWORD/CREDENTIAL/
 * API_KEY/DATABASE_URL/PRIVATE_KEY 等敏感关键字的一律剔除(双保险)
 * - 显式注入(secretsCache/opts.env)不过滤:调用方明确知情的注入,本就该传给命令
 */

/** 白名单变量名前缀(精确匹配或前缀匹配)。base + node/npm 生态。 */
const ENV_WHITELIST_PREFIXES = [
  // 基础执行环境(找命令/工作目录/终端)
  "PATH",
  "HOME",
  "USER",
  "USERNAME",
  "USERPROFILE",
  "SHELL",
  "TERM",
  "TMPDIR",
  "TEMP",
  "TMP",
  // Windows 基础
  "APPDATA",
  "LOCALAPPDATA",
  "PROGRAMFILES",
  "SYSTEMROOT",
  "COMSPEC",
  "OS",
  "PROCESSOR_ARCHITECTURE",
  "COMPUTERNAME",
  // locale / 时区
  "LANG",
  "LC_",
  "TZ",
  // node / npm / pnpm 生态(构建命令依赖)
  // 审计修复：移除 NODE_OPTIONS——已知代码执行攻击向量（--require/--inspect/--loader
  // 可注入任意脚本到所有子进程）。需要 --max-old-space-size 等安全选项时，
  // 通过 opts.env 显式注入（绕过白名单，调用方明确知情）。
  // 审计修复：移除 NODE_PATH——模块注入攻击向量（可让 require() 从攻击者控制的
  // 目录加载恶意模块，覆盖 npm 安装的模块），与 NODE_OPTIONS 属同一攻击类别。
  // 审计修复：将 NPM_CONFIG_ 前缀缩窄为具体安全变量——NPM_CONFIG_SCRIPT_SHELL 可替换 shell。
  // NPM_CONFIG_REGISTRY 保留：企业内网 registry 常用配置，供应链攻击在此场景风险有限。
  "NPM_CONFIG_USER_AGENT",
  "NPM_CONFIG_CACHE",
  "NPM_CONFIG_LOGLEVEL",
  "NPM_CONFIG_REGISTRY",
  "PNPM_HOME",
  "COREPACK_HOME",
  "YARN_",
  // 色彩/输出(非敏感)
  "FORCE_COLOR",
  "NO_COLOR",
  "CI",
] as const;

/**
 * 黑名单敏感关键字(变量名含任一即剔除,大小写不敏感)。
 * 双保险:即便白名单前缀匹配,名字含敏感关键字也剔除。
 */
const SENSITIVE_KEYWORDS =
  /SECRET|TOKEN|PASSWORD|PASSWD|CREDENTIAL|PRIVATE.?KEY|API.?KEY|DATABASE.?URL|CONN.?STRING|DSN|REGISTRY.?TOKEN|ACCESS.?KEY/i;

function isWhitelisted(name: string): boolean {
  return ENV_WHITELIST_PREFIXES.some((p) => name === p || name.startsWith(p));
}

function isSensitiveName(name: string): boolean {
  return SENSITIVE_KEYWORDS.test(name);
}

/**
 * 从 env 源过滤出命令执行的安全子集。
 * - 白名单前缀匹配 → 放行
 * - 名字含敏感关键字 → 剔除(即便在白名单内,双保险)
 * - 其余未匹配变量 → 剔除(默认 fail-closed,不透传未知的平台变量)
 *
 * @param inject 调用方显式注入的 env(secretsCache / opts.env),不过滤直接叠加
 * @param source env 源(默认 process.env;测试可传 mock)
 * @returns 过滤后的 env 对象(供 execa env 参数)
 */
export function buildSafeEnv(
  ...inject: Array<Record<string, string> | undefined>
): Record<string, string> {
  return filterEnv(process.env, ...inject);
}

/**
 * 内部:从指定 env 源过滤(供 buildSafeEnv 用 process.env,测试直接传 mock)。
 * source 类型放宽为 Record<string,string|undefined>,兼容 process.env 与测试字面量。
 */
export function filterEnv(
  source: Record<string, string | undefined>,
  ...inject: Array<Record<string, string> | undefined>
): Record<string, string> {
  const out: Record<string, string> = {};
  for (const [name, value] of Object.entries(source)) {
    if (value === undefined) continue;
    if (!isWhitelisted(name)) continue;
    if (isSensitiveName(name)) continue;
    out[name] = value;
  }
  // 显式注入叠在最后(调用方明确知情,优先级最高)
  for (const extra of inject) {
    if (!extra) continue;
    for (const [k, v] of Object.entries(extra)) {
      if (v !== undefined) out[k] = v;
    }
  }
  return out;
}
