/**
 * 唯一 Outbound Runtime Auth Resolver（03 专项：External Runtime Credential Authority）。
 *
 * 冻结不变量：
 * - SnowHarness → 第三方 External Harness Runtime endpoint 的所有真实网络调用
 *   （Registration / Conformance、Employee Start Invocation、Command Gateway
 *   Cancel/Resume）只能使用 RuntimeRevision.identityMode + RuntimeRevision.credentialRefId
 *   解析出的外部凭据；禁止 SnowHarness 内部 Workload Token 被当作外部 Runtime 的
 *   Bearer Token。
 * - 本模块是唯一共享 resolver（禁止三套实现）：只做
 *   tenantId + identityMode + credentialRefId → RuntimeTransportAuth，
 *   不发 HTTP、不选择 Route/Runtime、不解析 Agent Contract、不写 DB、不输出 secret。
 * - identityMode 阶段 1 只允许 none/bearer（external）；workload_token 仅限 Hosted /
 *   SnowHarness Runtime Protocol，External Runtime 侧本地 fail closed 不发网络；
 *   api_key 等已知但未实现的 mode 一律 fail closed，禁止自动映射 bearer。
 * - Secret 红线：external token 只允许存在于发请求前的短生命周期内存（RuntimeTransportAuth），
 *   不得进入 RuntimeRevision/ExecutionBinding/Audit/Thread/Event/Error/Logger/Trace/
 *   Idempotency response/Studio 持久化。
 * - Rotation 语义：RuntimeRevision 冻结 credentialRefId；ref rotated/revoked/expired
 *   时新网络调用立即 fail closed，不得自动切换到另一个 CredentialRef。
 */
import { createHash } from "node:crypto";
import { db } from "@/lib/db/client";
import { credentialRefTable } from "@/lib/persistence/schema/tool";
import { and, eq } from "drizzle-orm";

/**
 * 协议中立认证语义（03 §4）。Transport 负责把 auth 映射为 HTTP header：
 * - none：完全不发送 Authorization；
 * - bearer：Authorization: Bearer <external token>（仅 External Runtime）；
 * - workload_token：仅 Hosted / SnowHarness Runtime Protocol；External Runtime
 *   Transport 收到时本地 fail closed，不发网络。
 */
export type RuntimeTransportAuth =
  | { mode: "none" }
  | { mode: "workload_token"; token: string }
  | { mode: "bearer"; token: string };

/** Outbound auth 解析失败类别（网络调用前 fail closed）。 */
export type OutboundRuntimeAuthErrorKind =
  | "identity_mode_invalid" // identityMode 阶段 1 不支持（external 侧只允许 none/bearer）
  | "credential_ref_conflict" // identityMode 与 credentialRefId 组合非法
  | "credential_unresolvable"; // 凭证引用存在但不可解析/校验失败（不回显 token）

export class OutboundRuntimeAuthError extends Error {
  constructor(
    public readonly kind: OutboundRuntimeAuthErrorKind,
    message: string,
  ) {
    super(message);
    this.name = "OutboundRuntimeAuthError";
  }
}

/** 阶段 1 允许的 external identityMode。 */
const EXTERNAL_IDENTITY_MODES = new Set(["none", "bearer"]);

/**
 * 解析 external outbound auth（03 §5 精确规则）。
 *
 * - identityMode=none：要求 credentialRefId=null，输出 none；有 ref 拒绝。
 * - identityMode=bearer：要求 credentialRefId 非空，读取 CredentialRef 并逐项验证：
 *   同租户/存在/active/未过期/provider=env/vaultRef 环境变量存在/token 非空/
 *   fingerprint 与 token 重算一致。任一失败网络前 fail closed，不回显 token。
 * - 其他 identityMode（workload_token/api_key/...）：external 侧 fail closed。
 */
export async function resolveOutboundRuntimeAuth(params: {
  tenantId: string;
  identityMode: string;
  credentialRefId: string | null;
}): Promise<RuntimeTransportAuth> {
  if (!EXTERNAL_IDENTITY_MODES.has(params.identityMode)) {
    throw new OutboundRuntimeAuthError(
      "identity_mode_invalid",
      `External Runtime 不支持 identityMode=${params.identityMode}（阶段 1 仅 none/bearer）`,
    );
  }
  if (params.identityMode === "none") {
    if (params.credentialRefId !== null) {
      throw new OutboundRuntimeAuthError(
        "credential_ref_conflict",
        "identityMode=none 不允许携带 credentialRefId",
      );
    }
    return { mode: "none" };
  }
  // bearer：credentialRefId 必须存在。
  if (params.credentialRefId === null) {
    throw new OutboundRuntimeAuthError(
      "credential_ref_conflict",
      "identityMode=bearer 缺少 credentialRefId",
    );
  }
  const [ref] = await db
    .select()
    .from(credentialRefTable)
    .where(
      and(
        eq(credentialRefTable.tenantId, params.tenantId),
        eq(credentialRefTable.id, params.credentialRefId),
      ),
    )
    .limit(1);
  if (!ref) {
    throw new OutboundRuntimeAuthError("credential_unresolvable", "credential_ref 不存在或跨租户");
  }
  if (ref.lifecycleState !== "active") {
    // revoked/rotated：fail closed，不自动切换其他 CredentialRef（03 §13）。
    throw new OutboundRuntimeAuthError(
      "credential_unresolvable",
      `credential_ref 非 active（${ref.lifecycleState}）`,
    );
  }
  if (ref.expiresAt !== null && ref.expiresAt.getTime() <= Date.now()) {
    throw new OutboundRuntimeAuthError("credential_unresolvable", "credential_ref 已过期");
  }
  if (ref.provider !== "env") {
    throw new OutboundRuntimeAuthError(
      "credential_unresolvable",
      "阶段 1 仅支持 provider=env 的凭证引用",
    );
  }
  // vaultRef 是 env 变量名：只加载该字段，不落库/不回显/不写日志。
  const token = process.env[ref.vaultRef];
  if (typeof token !== "string" || token.length === 0) {
    throw new OutboundRuntimeAuthError(
      "credential_unresolvable",
      "凭证引用不可解析（env 缺失或为空）",
    );
  }
  const fingerprint = `sha256:${createHash("sha256").update(token, "utf8").digest("hex")}`;
  if (fingerprint !== ref.fingerprint) {
    throw new OutboundRuntimeAuthError("credential_unresolvable", "凭证指纹不匹配");
  }
  return { mode: "bearer", token };
}

/**
 * 把 RuntimeTransportAuth 映射为 HTTP header（03 §9）。
 *
 * - none：完全不发送 Authorization；
 * - bearer：Authorization: Bearer <external token>；
 * - workload_token：仅允许 Hosted / SnowHarness Runtime Protocol 调用方使用；
 *   External Runtime Transport 传入时本地 fail closed（调用方在网络前抛错）。
 */
export function outboundAuthHeaders(
  auth: RuntimeTransportAuth,
  options: { allowWorkloadToken?: boolean } = {},
): Record<string, string> {
  if (auth.mode === "none") return {};
  if (auth.mode === "bearer") return { authorization: `Bearer ${auth.token}` };
  if (options.allowWorkloadToken) return { authorization: `Bearer ${auth.token}` };
  // External Runtime 收到 workload_token：本地 fail closed，不发网络（03 §9）。
  throw new OutboundRuntimeAuthError(
    "identity_mode_invalid",
    "External Runtime Transport 不允许使用内部 Workload Token 作为 outbound 凭据",
  );
}
