"use client";

import { useBrand } from "@/components/brand/brand-provider";

/** 纯品牌名文本（侧栏、导航、按钮文案等复用）。 */
export function BrandName({ className }: { readonly className?: string }) {
  const brand = useBrand();
  return <span className={className}>{brand.name}</span>;
}
