/**
 * Runner 签名身份注册 — 将可信密钥与被授权的 Runner 身份一一绑定。
 *
 * 核心原则：
 * - 一个可信密钥只能代表被明确授权的 Runner 身份。
 * - Key 可信 ≠ Runner Identity 可用：必须存在显式授权绑定。
 * - 授权绑定具有租户范围、有效期和撤销状态。
 * - 同一 Runner 可以轮换 Key（不同 keyId → 同一 runnerIdentity），但同一 Key 不可跨 Runner。
 *
 * 此模块是纯逻辑（不访问 DB）；注册表由配置或 PolicyRevision 提供。
 */

// ─── Runner Signing Identity ─────────────────────────────

/**
 * Runner 签名身份授权记录。
 *
 * 每条记录将一个 Ed25519 公钥（keyId）与一个 Runner 身份（runnerIdentity）绑定，
 * 并限定租户范围、有效期和撤销状态。
 */
export interface RunnerSigningIdentity {
 /** 签名密钥 ID（与 DSSE Envelope 中的 keyid 一致）。 */
 keyId: string;
 /** Base64 编码的 Ed25519 公钥（32 字节 raw）。 */
 publicKey: string;
 /** 被授权的 Runner 身份（如 "ci/hosted-runtime-conformance"）。 */
 runnerIdentity: string;
 /** 授权的租户范围（null 表示全局授权，不限租户）。 */
 tenantScope: string | null;
 /** 授权生效时间（ISO 8601）。 */
 validFrom: string;
 /** 授权失效时间（ISO 8601）；null 表示永不过期。 */
 validUntil: string | null;
 /** 撤销时间（ISO 8601）；null 表示未撤销。 */
 revokedAt: string | null;
}

// ─── Registry ────────────────────────────────────────────

/**
 * Runner 签名身份注册表。
 *
 * 提供 keyId → RunnerSigningIdentity 的查找，
 * 以及 keyId + runnerIdentity + tenantScope 的完整校验。
 */
export class RunnerSigningIdentityRegistry {
 private readonly byKeyId = new Map<string, RunnerSigningIdentity[]>();

 constructor(entries: readonly RunnerSigningIdentity[]) {
  for (const entry of entries) {
   const existing = this.byKeyId.get(entry.keyId) ?? [];
   existing.push(entry);
   this.byKeyId.set(entry.keyId, existing);
  }
 }

 /**
  * 查找 keyId 对应的所有授权记录。
  */
 findByKeyId(keyId: string): RunnerSigningIdentity[] {
  return this.byKeyId.get(keyId) ?? [];
 }

 /**
  * 完整校验：keyId 绑定 runnerIdentity + tenantScope + 有效期 + 未撤销。
  *
  * 返回 null 表示校验通过（并返回匹配的注册记录），
  * 返回字符串表示失败原因。
  */
 validate(params: {
  keyId: string;
  runnerIdentity: string;
  tenantId: string;
  now: Date;
 }): { ok: true; entry: RunnerSigningIdentity } | { ok: false; failureReason: string } {
  const entries = this.findByKeyId(params.keyId);

  if (entries.length === 0) {
   return { ok: false, failureReason: "runner_key_not_registered" };
  }

  // 找到 keyId + runnerIdentity 匹配的记录
  const matching = entries.filter((e) => e.runnerIdentity === params.runnerIdentity);
  if (matching.length === 0) {
   return { ok: false, failureReason: "runner_key_identity_mismatch" };
  }

  // 校验租户范围
  const tenantMatched = matching.filter(
   (e) => e.tenantScope === null || e.tenantScope === params.tenantId,
  );
  if (tenantMatched.length === 0) {
   return { ok: false, failureReason: "runner_key_cross_tenant" };
  }

  // 校验有效期
  const nowIso = params.now.toISOString();
  const validEntries = tenantMatched.filter((e) => {
   if (e.validFrom > nowIso) return false;
   if (e.validUntil !== null && e.validUntil < nowIso) return false;
   return true;
  });
  if (validEntries.length === 0) {
   return { ok: false, failureReason: "runner_key_expired" };
  }

  // 校验未撤销
  const activeEntries = validEntries.filter((e) => e.revokedAt === null);
  if (activeEntries.length === 0) {
   return { ok: false, failureReason: "runner_key_revoked" };
  }

  // 返回第一个匹配的活跃记录
  return { ok: true, entry: activeEntries[0]! };
 }

 /**
  * 提取所有公钥（供 DSSE 验签使用）。
  *
  * 返回 keyId → publicKey 的映射，仅包含未撤销且在有效期内的记录。
  */
 getActivePublicKeys(now: Date): Record<string, string> {
  const result: Record<string, string> = {};
  const nowIso = now.toISOString();

  for (const entries of this.byKeyId.values()) {
   for (const entry of entries) {
    if (entry.revokedAt !== null) continue;
    if (entry.validFrom > nowIso) continue;
    if (entry.validUntil !== null && entry.validUntil < nowIso) continue;
    result[entry.keyId] = entry.publicKey;
   }
  }

  return result;
 }
}
