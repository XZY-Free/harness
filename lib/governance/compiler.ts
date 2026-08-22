/**
 * Governance Config canonicalization（关口02 02-6 · 冻结方案 §5.3 / §54-P2）。
 *
 * configDigest = sha256: + SHA256(canonical(configJson))。
 * Canonical JSON：对象 key 递归字典序排序、数组保序、字符串保持原值，
 * 不含 id / revisionNo / timestamp。
 */
import { computeCanonicalDigest } from "@/lib/crypto/rfc-8785-canonicalize";
import type { GovernanceConfig } from "@/lib/persistence/schema/governance-config";

/**
 * 计算 Governance configDigest（§5.3）。返回带 `sha256:` 前缀。
 * 同一 config 内容 → 恒定 digest（digest stability，§55.1）。
 */
export function canonicalizeGovernanceConfig(config: GovernanceConfig): string {
  return computeCanonicalDigest(config);
}
