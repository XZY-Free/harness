import {
  type DependencyEntry,
  LockfileParseError,
  parseLockfile,
  parsePackageLockJson,
  parsePnpmLockYaml,
} from "@/lib/v11/supply-chain/lockfile-parser";
import {
  NullVulnerabilityProvider,
  type VulnerabilityProvider,
  generateSbom,
  summarizeSbom,
} from "@/lib/v11/supply-chain/sbom-generator";
/**
 * S12-W04：依赖锁定文件解析器 + SBOM 生成器单元测试。
 *
 * 覆盖：
 * - parsePackageLockJson：v3 packages 段 / v2 dependencies 段 / 许可证拆分 / 无效 JSON
 * - parsePnpmLockYaml：packages 段 / dependencies 段 / 段切换
 * - parseLockfile：统一入口 / 不支持的格式
 * - generateSbom：空列表 / 有漏洞 / provider 失败 fail-closed
 * - summarizeSbom：漏洞计数 / 阻断许可证计数
 */
import { describe, expect, it } from "vitest";

// ─── parsePackageLockJson ─────────────────────────────────

describe("parsePackageLockJson", () => {
  it("v3 packages 段解析 + 许可证透传", () => {
    const content = JSON.stringify({
      name: "test",
      lockfileVersion: 3,
      packages: {
        "": { version: "1.0.0" },
        "node_modules/react": { version: "18.2.0", license: "MIT" },
        "node_modules/@scope/pkg": {
          version: "2.1.0",
          license: ["MIT", "Apache-2.0"],
        },
        "node_modules/lodash": { version: "4.17.21", license: "MIT" },
      },
    });

    const entries = parsePackageLockJson(content);
    expect(entries).toHaveLength(3);
    expect(entries[0]).toEqual({
      name: "react",
      version: "18.2.0",
      licenses: ["MIT"],
      vulnerabilities: [],
      source: "npm",
    });
    expect(entries[1]).toEqual({
      name: "@scope/pkg",
      version: "2.1.0",
      licenses: ["MIT", "Apache-2.0"],
      vulnerabilities: [],
      source: "npm",
    });
    expect(entries[2]?.name).toBe("lodash");
  });

  it("许可证 OR 表达式拆分", () => {
    const content = JSON.stringify({
      lockfileVersion: 3,
      packages: {
        "node_modules/multi-license": {
          version: "1.0.0",
          license: "MIT OR Apache-2.0",
        },
      },
    });

    const entries = parsePackageLockJson(content);
    expect(entries[0]?.licenses).toEqual(["MIT", "Apache-2.0"]);
  });

  it("v2 dependencies 段 fallback", () => {
    const content = JSON.stringify({
      lockfileVersion: 2,
      dependencies: {
        react: { version: "18.2.0", license: "MIT" },
        lodash: { version: "4.17.21" },
      },
    });

    const entries = parsePackageLockJson(content);
    expect(entries).toHaveLength(2);
    expect(entries[0]?.name).toBe("react");
    expect(entries[1]?.licenses).toEqual([]);
  });

  it("跳过无 version 的条目", () => {
    const content = JSON.stringify({
      lockfileVersion: 3,
      packages: {
        "node_modules/no-version": { license: "MIT" },
        "node_modules/has-version": { version: "1.0.0" },
      },
    });

    const entries = parsePackageLockJson(content);
    expect(entries).toHaveLength(1);
    expect(entries[0]?.name).toBe("has-version");
  });

  it("无效 JSON 抛 LockfileParseError", () => {
    expect(() => parsePackageLockJson("{invalid")).toThrow(LockfileParseError);
  });

  it("空对象返回空数组", () => {
    const entries = parsePackageLockJson("{}");
    expect(entries).toEqual([]);
  });
});

// ─── parsePnpmLockYaml ────────────────────────────────────

describe("parsePnpmLockYaml", () => {
  it("packages 段解析", () => {
    const content = `lockfileVersion: '6.0'
settings:
  autoInstallPeers: true
packages:
  /react@18.2.0:
    resolution: {integrity: sha512-abc}
  /@scope/pkg@2.1.0:
    resolution: {integrity: sha256-def}
  /lodash@4.17.21:
    resolution: {integrity: sha512-ghi}
`;

    const entries = parsePnpmLockYaml(content);
    expect(entries).toHaveLength(3);
    expect(entries[0]).toEqual({
      name: "react",
      version: "18.2.0",
      licenses: [],
      vulnerabilities: [],
      source: "pnpm",
    });
    expect(entries[1]?.name).toBe("@scope/pkg");
    expect(entries[2]?.name).toBe("lodash");
  });

  it("dependencies 段解析", () => {
    const content = `lockfileVersion: '6.0'
dependencies:
  react: 18.2.0
  lodash: 4.17.21
`;

    const entries = parsePnpmLockYaml(content);
    expect(entries).toHaveLength(2);
    expect(entries[0]?.name).toBe("react");
    expect(entries[1]?.version).toBe("4.17.21");
  });

  it("空内容返回空数组", () => {
    const entries = parsePnpmLockYaml("");
    expect(entries).toEqual([]);
  });
});

// ─── parseLockfile 统一入口 ───────────────────────────────

describe("parseLockfile", () => {
  it("npm 格式", () => {
    const content = JSON.stringify({
      lockfileVersion: 3,
      packages: { "node_modules/react": { version: "18.2.0" } },
    });
    const entries = parseLockfile(content, "npm");
    expect(entries).toHaveLength(1);
    expect(entries[0]?.source).toBe("npm");
  });

  it("pnpm 格式", () => {
    const content = "packages:\n  /react@18.2.0:\n";
    const entries = parseLockfile(content, "pnpm");
    expect(entries).toHaveLength(1);
    expect(entries[0]?.source).toBe("pnpm");
  });
});

// ─── generateSbom ─────────────────────────────────────────

describe("generateSbom", () => {
  it("空依赖列表返回空 SBOM", async () => {
    const sbom = await generateSbom([]);
    expect(sbom.packages).toEqual([]);
  });

  it("带漏洞 provider 生成 vulnerabilities", async () => {
    const entries: DependencyEntry[] = [
      {
        name: "lodash",
        version: "4.17.20",
        licenses: ["MIT"],
        vulnerabilities: [],
        source: "npm",
      },
    ];

    const provider: VulnerabilityProvider = {
      async queryVulnerabilities(name) {
        if (name === "lodash") {
          return [{ id: "CVE-2021-23337", severity: "high" as const }];
        }
        return [];
      },
    };

    const sbom = await generateSbom(entries, provider);
    expect(sbom.packages).toHaveLength(1);
    expect(sbom.packages[0]?.vulnerabilities).toEqual([{ id: "CVE-2021-23337", severity: "high" }]);
  });

  it("provider 失败时 fail-closed 抛错", async () => {
    const entries: DependencyEntry[] = [
      {
        name: "broken",
        version: "1.0.0",
        licenses: [],
        vulnerabilities: [],
        source: "npm",
      },
    ];

    const provider: VulnerabilityProvider = {
      async queryVulnerabilities() {
        throw new Error("网络不可达");
      },
    };

    await expect(generateSbom(entries, provider)).rejects.toThrow(/漏洞查询失败.*网络不可达/);
  });

  it("NullVulnerabilityProvider 返回空漏洞列表", async () => {
    const entries: DependencyEntry[] = [
      {
        name: "react",
        version: "18.2.0",
        licenses: ["MIT"],
        vulnerabilities: [],
        source: "npm",
      },
    ];

    const sbom = await generateSbom(entries, new NullVulnerabilityProvider());
    expect(sbom.packages[0]?.vulnerabilities).toEqual([]);
  });
});

// ─── summarizeSbom ────────────────────────────────────────

describe("summarizeSbom", () => {
  it("统计漏洞数和阻断许可证数", () => {
    const sbom = {
      packages: [
        {
          name: "pkg-a",
          version: "1.0.0",
          licenses: ["MIT"],
          vulnerabilities: [{ id: "CVE-1", severity: "high" as const }],
        },
        {
          name: "pkg-b",
          version: "2.0.0",
          licenses: ["GPL-3.0"],
          vulnerabilities: [
            { id: "CVE-2", severity: "critical" as const },
            { id: "CVE-3", severity: "low" as const },
          ],
        },
        {
          name: "pkg-c",
          version: "3.0.0",
          licenses: ["AGPL-3.0", "MIT"],
          vulnerabilities: [],
        },
      ],
    };

    const summary = summarizeSbom(sbom);
    expect(summary.packagesScanned).toBe(3);
    expect(summary.vulnerabilityCount).toBe(3);
    expect(summary.blockedLicenseCount).toBe(2);
  });

  it("空 SBOM 返回零计数", () => {
    const summary = summarizeSbom({ packages: [] });
    expect(summary.packagesScanned).toBe(0);
    expect(summary.vulnerabilityCount).toBe(0);
    expect(summary.blockedLicenseCount).toBe(0);
  });
});
