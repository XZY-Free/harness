/**
 * Runtime/AgentCall 共用的 External Outbound Credential Authority。
 *
 * 协议中立长期 Authority：只做 tenantId + identityMode + credentialRefId →
 * OutboundCredentialAuth，为后续 AgentCall A2A exact binding 提供同一份外部凭证解析。
 * 不发 HTTP、不选择 Route/Runtime、不解析 Agent Contract、不写 DB、不输出 secret。
 *
 * 冻结不变量：
 * - identityMode 只允许 none/bearer（external）；workload_token 属 Runtime hosted token，
 *   留在 Runtime 域调用方，本 external authority 一律 fail closed，禁止自动映射 bearer；
 *   api_key 等已知但未实现的 mode 一律 fail closed。
 * - none 要求 credentialRefId=null；bearer 要求 exact ref，缺失即拒绝（组合 fail closed）。
 * - bearer 精确按 tenant+ref 查询 CredentialRef 并逐项验证：同租户/存在/active/未过期/
 *   provider=env/env token 非空/sha256 fingerprint 与 token 重算一致。任一失败网络前 fail closed。
 * - Rotation 语义：调用方冻结 credentialRefId；ref rotated/revoked/expired/missing 时
 *   立即 fail closed，不自动切换到其它 CredentialRef。
 * - Secret 红线：external token 只存在于发请求前的短生命周期内存（OutboundCredentialAuth），
 *   不进入 Error/Logger/Trace 等；错误 message/JSON 不回显 token。只 select 必要字段，
 *   不整行读取后再脱敏。
 */
import { createHash } from "node:crypto";
import { db } from "@/lib/db/client";
import { credentialRefTable } from "@/lib/persistence/schema/tool";
import { and, eq } from "drizzle-orm";

/** 协议中立认证语义（Transport 负责映射为 HTTP header）。 */
export type OutboundCredentialAuth = { mode: "none" } | { mode: "bearer"; token: string };

/** Outbound 凭证解析失败类别（网络调用前 fail closed）。 */
export type OutboundCredentialErrorKind =
  | "identity_mode_invalid" // identityMode 阶段不支持（external 只允许 none/bearer）
  | "credential_ref_conflict" // identityMode 与 credentialRefId 组合非法
  | "credential_unresolvable"; // 凭证引用存在但不可解析/校验失败（不回显 token）

export class OutboundCredentialError extends Error {
  constructor(
    public readonly kind: OutboundCredentialErrorKind,
    message: string,
  ) {
    super(message);
    this.name = "OutboundCredentialError";
  }
}

/** 允许的 external identityMode。 */
const EXTERNAL_IDENTITY_MODES = new Set(["none", "bearer"]);

/**
 * 解析 external outbound credential（exact binding 规则）。
 *
 * - identityMode=none：要求 credentialRefId=null，输出 none；有 ref 拒绝。
 * - identityMode=bearer：要求 credentialRefId 非空，按 tenant+ref 精确查询 CredentialRef
 *   并逐项验证（同租户/存在/active/未过期/provider=env/vaultRef env token 非空/
 *   fingerprint 与 token 重算一致）。任一失败网络前 fail closed，不回显 token。
 * - 其他 identityMode（workload_token/api_key/...）：external 侧 fail closed。
 */
export async function resolveOutboundCredential(params: {
  tenantId: string;
  identityMode: string;
  credentialRefId: string | null;
}): Promise<OutboundCredentialAuth> {
  if (!EXTERNAL_IDENTITY_MODES.has(params.identityMode)) {
    throw new OutboundCredentialError(
      "identity_mode_invalid",
      `External outbound credential 不支持 identityMode=${params.identityMode}（仅 none/bearer）`,
    );
  }
  if (params.identityMode === "none") {
    if (params.credentialRefId !== null) {
      throw new OutboundCredentialError(
        "credential_ref_conflict",
        "identityMode=none 不允许携带 credentialRefId",
      );
    }
    return { mode: "none" };
  }
  // bearer：credentialRefId 必须存在，blank 同样视为缺失。
  if (params.credentialRefId === null || params.credentialRefId === "") {
    throw new OutboundCredentialError(
      "credential_ref_conflict",
      "identityMode=bearer 缺少 credentialRefId",
    );
  }
  // 只读取验证所需的必要字段，不整行 select 后脱敏。
  const [ref] = await db
    .select({
      lifecycleState: credentialRefTable.lifecycleState,
      expiresAt: credentialRefTable.expiresAt,
      provider: credentialRefTable.provider,
      vaultRef: credentialRefTable.vaultRef,
      fingerprint: credentialRefTable.fingerprint,
    })
    .from(credentialRefTable)
    .where(
      and(
        eq(credentialRefTable.tenantId, params.tenantId),
        eq(credentialRefTable.id, params.credentialRefId),
      ),
    )
    .limit(1);
  if (!ref) {
    throw new OutboundCredentialError("credential_unresolvable", "credential_ref 不存在或跨租户");
  }
  if (ref.lifecycleState !== "active") {
    // revoked/rotated：fail closed，不自动切换其它 CredentialRef。
    throw new OutboundCredentialError(
      "credential_unresolvable",
      `credential_ref 非 active（${ref.lifecycleState}）`,
    );
  }
  if (ref.expiresAt !== null && ref.expiresAt.getTime() <= Date.now()) {
    throw new OutboundCredentialError("credential_unresolvable", "credential_ref 已过期");
  }
  if (ref.provider !== "env") {
    throw new OutboundCredentialError("credential_unresolvable", "仅支持 provider=env 的凭证引用");
  }
  // vaultRef 是 env 变量名：只加载该字段，不落库/不回显/不写日志。
  const token = process.env[ref.vaultRef];
  if (typeof token !== "string" || token.length === 0) {
    throw new OutboundCredentialError(
      "credential_unresolvable",
      "凭证引用不可解析（env 缺失或为空）",
    );
  }
  const fingerprint = `sha256:${createHash("sha256").update(token, "utf8").digest("hex")}`;
  if (fingerprint !== ref.fingerprint) {
    throw new OutboundCredentialError("credential_unresolvable", "凭证指纹不匹配");
  }
  return { mode: "bearer", token };
}

/**
 * 把 OutboundCredentialAuth 映射为 HTTP header。
 *
 * - none：完全不发送 Authorization；
 * - bearer：Authorization: Bearer <external token> 原样映射；
 * - 其它/未知形状（如 workload_token）：不属于 external authority，运行时本地 fail closed。
 */
export function outboundCredentialHeaders(auth: OutboundCredentialAuth): Record<string, string> {
  if (auth.mode === "none") return {};
  if (auth.mode === "bearer") return { authorization: `Bearer ${auth.token}` };
  // 未知/不允许形状：本地 fail closed，不发网络。
  throw new OutboundCredentialError(
    "identity_mode_invalid",
    "External outbound credential 不允许该认证形状（仅 none/bearer）",
  );
}
