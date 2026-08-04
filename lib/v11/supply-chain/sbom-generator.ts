/**
 * V11 SBOM 生成器（S12-W04）。
 *
 * 事实源：../v11-agentkit-platform/14-production-operations-security-and-retention.md §4
 *         （npm、Python、Electron 和基础镜像依赖纳入锁定、漏洞扫描和升级流程）。
 *
 * 职责：
 * - 将 lockfile-parser 输出的 DependencyEntry[] 转换为 SbomDocument（attestation 验证服务输入）。
 * - 支持注入漏洞数据库查询结果（VulnerabilityProvider 接口）。
 * - 不执行网络请求（由调用方注入 provider）。
 *
 * 关键约束：
 * - 纯逻辑：不读文件系统、不访问网络。
 * - 空依赖列表返回空 packages（不抛错；空 SBOM 也是有效 SBOM）。
 * - 漏洞 provider 失败时 fail-closed（抛错，不静默跳过）。
 */
import type { SbomDocument, SbomPackage } from "@/lib/artifacts/domain/artifact-attestation";
import type { DependencyEntry } from "@/lib/v11/supply-chain/lockfile-parser";

/** 漏洞查询接口（调用方注入，实现可以是 OSV / GHSA 适配器）。 */
export interface VulnerabilityProvider {
  /**
   * 查询包的已知漏洞。
   * @returns 漏洞列表（空数组表示无已知漏洞）。
   * @throws Error 查询失败（fail-closed，不返回空数组冒充成功）。
   */
  queryVulnerabilities(
    name: string,
    version: string,
  ): Promise<
    Array<{
      id: string;
      severity: "critical" | "high" | "medium" | "low";
    }>
  >;
}

/** NullVulnerabilityProvider：不查询任何漏洞（所有包返回空列表）。仅用于测试/本地开发。 */
export class NullVulnerabilityProvider implements VulnerabilityProvider {
  async queryVulnerabilities(): Promise<
    Array<{ id: string; severity: "critical" | "high" | "medium" | "low" }>
  > {
    return [];
  }
}

/**
 * 从依赖清单 + 漏洞 provider 生成 SbomDocument。
 *
 * @param entries 依赖清单（来自 lockfile-parser）
 * @param vulnProvider 漏洞查询 provider（默认 NullVulnerabilityProvider）
 */
export async function generateSbom(
  entries: DependencyEntry[],
  vulnProvider?: VulnerabilityProvider,
): Promise<SbomDocument> {
  const provider = vulnProvider ?? new NullVulnerabilityProvider();
  const packages: SbomPackage[] = [];

  for (const entry of entries) {
    // 查询漏洞（provider 失败时 fail-closed）
    let vulnerabilities: Array<{ id: string; severity: "critical" | "high" | "medium" | "low" }>;
    try {
      vulnerabilities = await provider.queryVulnerabilities(entry.name, entry.version);
    } catch (e) {
      throw new Error(`漏洞查询失败（${entry.name}@${entry.version}）: ${(e as Error).message}`);
    }

    packages.push({
      name: entry.name,
      version: entry.version,
      licenses: entry.licenses,
      vulnerabilities,
    });
  }

  return { packages };
}

/**
 * 统计 SBOM 中的漏洞数和阻断许可证命中数（用于 scanSummary）。
 */
export function summarizeSbom(sbom: SbomDocument): {
  packagesScanned: number;
  vulnerabilityCount: number;
  blockedLicenseCount: number;
} {
  let vulnerabilityCount = 0;
  let blockedLicenseCount = 0;
  const blockedLicenses = new Set([
    "GPL-2.0",
    "GPL-3.0",
    "AGPL-3.0",
    "GPL-2.0-only",
    "GPL-3.0-only",
    "AGPL-3.0-only",
  ]);

  for (const pkg of sbom.packages) {
    vulnerabilityCount += pkg.vulnerabilities.length;
    for (const license of pkg.licenses) {
      if (blockedLicenses.has(license)) {
        blockedLicenseCount++;
      }
    }
  }

  return {
    packagesScanned: sbom.packages.length,
    vulnerabilityCount,
    blockedLicenseCount,
  };
}
