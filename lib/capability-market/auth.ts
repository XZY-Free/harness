/**
 * capability-market 调用鉴权（统一入口）。
 *
 * 设计（2026-10-17 定稿，用户拍板）：
 * - **主路径 = 用户登录 token 透传**：用户在 auth-center 登录后拿到会话 token，
 *   该 token 从请求一路透传到 capm 调用，**不再为每个用途单独配置 token**。
 * - **实现 = 请求作用域（AsyncLocalStorage）**：在 HTTP 入口把用户 token 注入
 *   请求作用域；此作用域内的所有 capm 调用（检索 / 目录 / 同步 / mcp）自动取用。
 *   异步 worker 由触发请求在派发时把 token 注入其作用域（内存透传，不落库）。
 * - **兜底 = env token（过渡）**：capm 尚未接入 auth-center 校验用户 token 期间，
 *   允许以 env token 兜底（见 capabilityMarketConfig.token）。auth-center ↔ capm
 *   联调完成后**删除**兜底，仅保留用户 token 主路径。
 *
 * Secret 红线：token 只存在于内存（请求作用域），不落库、不进日志、不回显。
 */
import { AsyncLocalStorage } from "node:async_hooks";
import { capabilityMarketConfig } from "@/lib/config";

interface CapmAuthContext {
  /** 请求作用域的用户登录 token（主路径）。 */
  userToken: string | null;
}

const capmAuthStorage = new AsyncLocalStorage<CapmAuthContext>();

/**
 * 在指定用户 token 的作用域内执行（HTTP 入口 / worker 派发用）。
 *
 * @param userToken 用户登录 token（null 表示无，落回 env 兜底）
 * @param fn 作用域内执行的函数（其调用链内的 capm 调用自动取用该 token）
 */
export function runWithCapmAuth<T>(userToken: string | null, fn: () => T): T {
  return capmAuthStorage.run({ userToken }, fn);
}

/** 当前作用域内的用户 token（无作用域 / 未注入 → null）。 */
export function currentCapmUserToken(): string | null {
  return capmAuthStorage.getStore()?.userToken ?? null;
}

export interface CapmAuth {
  token: string;
  /** 来源：user（用户登录 token，主路径）/ env（过渡兜底）。 */
  source: "user" | "env";
}

/**
 * 解析一次 capm 调用应使用的 Bearer token。
 *
 * 优先级：请求作用域用户 token → env 兜底。
 * 两者皆无 → null（调用方按「未配置」处理，明确失败不静默）。
 *
 * @param envFallback 兜底用的 env token（各调用点各自的过渡变量；
 *   auth-center ↔ capm 联调完成后删除对应 env 即可，本函数签名不变）
 */
export function resolveCapmAuth(
  envFallback: string | null = capabilityMarketConfig.token,
): CapmAuth | null {
  const userToken = currentCapmUserToken();
  if (userToken) return { token: userToken, source: "user" };
  if (envFallback) return { token: envFallback, source: "env" };
  return null;
}

/**
 * 构造 capm 请求的鉴权头（无可用 token 时抛错，由调用方映射为未配置/不可用）。
 *
 * @param envFallback 兜底 env token（见 resolveCapmAuth）
 */
export function capmAuthHeaders(envFallback: string | null = capabilityMarketConfig.token): {
  authorization: string;
} {
  const auth = resolveCapmAuth(envFallback);
  if (!auth) {
    throw new CapmAuthUnavailableError();
  }
  return { authorization: `Bearer ${auth.token}` };
}

/** capm 鉴权不可用（无用户 token 且无 env 兜底）。 */
export class CapmAuthUnavailableError extends Error {
  constructor() {
    super("capability-market 鉴权不可用（无用户登录 token，且未配置兜底 token）");
    this.name = "CapmAuthUnavailableError";
  }
}
