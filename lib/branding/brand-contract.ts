/**
 * 品牌合同：BrandContract 文档结构、校验与 overlay 合并。
 *
 * 定案（2026-09-11）：一份 schema 多层存储——DB 单行文档为主存储，branding.json 与
 * SNOW_BRAND_* 为部署期 pin 层，代码默认兜底。revision 单调递增，是热更新与缓存失效唯一依据。
 * 本模块零副作用：不读 env、不读文件、不访问 DB，纯类型与纯函数，供 store / 端点 / 测试共用。
 */

export interface BrandLogoRef {
  readonly light: string | null;
  readonly dark: string | null;
}

export interface BrandPackaging {
  readonly productName: string;
  readonly appId: string;
  readonly dockLabel: string;
}

export interface BrandContract {
  readonly schemaVersion: 1;
  readonly revision: number;
  readonly name: string;
  readonly tagline: string | null;
  readonly logo: BrandLogoRef;
  readonly icon: string | null;
  readonly packaging: BrandPackaging;
  readonly updatedAt: string | null;
  readonly updatedBy: string | null;
}

/** 可写 patch：仅允许部分字段，revision/updatedAt/updatedBy 由 store 维护。 */
export interface BrandPatch {
  readonly name?: string;
  readonly tagline?: string | null;
  readonly logo?: Partial<BrandLogoRef>;
  readonly icon?: string | null;
  readonly packaging?: Partial<BrandPackaging>;
}

export const DEFAULT_BRAND: BrandContract = {
  schemaVersion: 1,
  revision: 0,
  name: "NexHarness",
  tagline: "AI 驱动的「从想法到上线」工作台",
  logo: { light: "/brand/nexharness-mark.png", dark: null },
  icon: "/brand/nexharness-mark.png",
  packaging: {
    productName: "NexHarness",
    appId: "cn.nexharness.desktop",
    dockLabel: "NexHarness",
  },
  updatedAt: null,
  updatedBy: null,
};

export class BrandValidationError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "BrandValidationError";
  }
}

/** 被 file/env pin 的字段拒绝 API 写入。 */
export class BrandFieldPinnedError extends Error {
  constructor(
    readonly field: string,
    readonly pinnedBy: "file" | "env",
  ) {
    super(
      `品牌字段 ${field} 已被 ${pinnedBy === "file" ? "branding.json" : "环境变量"} pin，拒绝接口写入`,
    );
    this.name = "BrandFieldPinnedError";
  }
}

/**
 * 资源路径校验：必须根相对、禁协议、禁 //、禁反斜杠、禁 data:/javascript: 等 scheme。
 * 与登录 returnTo 的 safeReturnTo 同一安全思路，防外链注入与路径穿越。
 */
export function validateBrandAssetPath(value: string, field: string): string {
  const trimmed = value.trim();
  if (!trimmed.startsWith("/")) {
    throw new BrandValidationError(`${field} 必须为根相对路径：${value}`);
  }
  if (trimmed.startsWith("//") || trimmed.includes("\\") || trimmed.includes("..")) {
    throw new BrandValidationError(`${field} 含非法路径片段：${value}`);
  }
  if (/^[a-zA-Z][a-zA-Z0-9+.-]*:/.test(trimmed)) {
    throw new BrandValidationError(`${field} 不允许携带 scheme：${value}`);
  }
  if (!/\.(svg|png|webp|jpe?g)$/i.test(trimmed)) {
    throw new BrandValidationError(`${field} 仅支持 svg/png/webp/jpeg：${value}`);
  }
  return trimmed;
}

function validateName(value: string): string {
  const trimmed = value.trim();
  if (trimmed.length < 1 || trimmed.length > 40) {
    throw new BrandValidationError(`name 长度必须 1-40：${value}`);
  }
  return trimmed;
}

/** 把 patch 应用到 base 上并做全量校验；不修改入参。 */
export function applyBrandPatch(base: BrandContract, patch: BrandPatch): BrandContract {
  const next: BrandContract = {
    ...base,
    name: patch.name !== undefined ? validateName(patch.name) : base.name,
    tagline: patch.tagline !== undefined ? patch.tagline : base.tagline,
    logo: {
      light:
        patch.logo?.light !== undefined
          ? patch.logo.light === null
            ? null
            : validateBrandAssetPath(patch.logo.light, "logo.light")
          : base.logo.light,
      dark:
        patch.logo?.dark !== undefined
          ? patch.logo.dark === null
            ? null
            : validateBrandAssetPath(patch.logo.dark, "logo.dark")
          : base.logo.dark,
    },
    icon:
      patch.icon !== undefined
        ? patch.icon === null
          ? null
          : validateBrandAssetPath(patch.icon, "icon")
        : base.icon,
    packaging: {
      productName:
        patch.packaging?.productName !== undefined
          ? validateName(patch.packaging.productName)
          : base.packaging.productName,
      appId: patch.packaging?.appId ?? base.packaging.appId,
      dockLabel: patch.packaging?.dockLabel ?? base.packaging.dockLabel,
    },
  };
  return next;
}

/** overlay 合并：pin 层字段覆盖 base（pin 值同样要过校验）。 */
export function mergeBrandOverlay(base: BrandContract, overlay: BrandPatch): BrandContract {
  return applyBrandPatch(base, overlay);
}

/** 从未知 JSON（DB document / branding.json）宽松解析为 patch；坏字段抛校验错。 */
export function parseBrandPatch(input: Record<string, unknown>): BrandPatch {
  const patch: Record<string, unknown> = {};
  if (input.name !== undefined) patch.name = input.name;
  if (input.tagline !== undefined) patch.tagline = input.tagline;
  if (input.icon !== undefined) patch.icon = input.icon;
  if (input.logo !== undefined) {
    const logo = input.logo as Record<string, unknown>;
    patch.logo = { light: logo.light, dark: logo.dark };
  }
  if (input.packaging !== undefined) {
    const packaging = input.packaging as Record<string, unknown>;
    patch.packaging = {
      productName: packaging.productName,
      appId: packaging.appId,
      dockLabel: packaging.dockLabel,
    };
  }
  return patch as BrandPatch;
}
