/**
 * 品牌展示投影：从 BrandContract 提取 UI 需要的最小字段。
 * 组件只消费投影，不接触 revision/审计等服务端字段。
 */
import type { BrandContract } from "@/lib/branding/brand-contract";

export interface BrandPresentation {
  readonly name: string;
  readonly tagline: string | null;
  readonly logoLight: string | null;
  readonly logoDark: string | null;
  readonly icon: string | null;
}

export function toBrandPresentation(contract: BrandContract): BrandPresentation {
  return {
    name: contract.name,
    tagline: contract.tagline,
    logoLight: contract.logo.light,
    logoDark: contract.logo.dark,
    icon: contract.icon,
  };
}
