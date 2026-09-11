"use client";

/**
 * 品牌 wordmark：logo（配置时）+ 名称文字。
 * 未配置 logo 时保持纯文字 wordmark（与现状视觉一致）。
 */
import { useBrand } from "@/components/brand/brand-provider";

export function BrandWordmark({ className }: { readonly className?: string }) {
  const brand = useBrand();
  return (
    <span className={`inline-flex items-center gap-2 ${className ?? ""}`}>
      {brand.logoLight ? (
        // eslint-disable-next-line @next/next/no-img-element
        <img
          src={brand.logoLight}
          alt=""
          aria-hidden="true"
          className="h-[1.15em] w-[1.15em] shrink-0"
        />
      ) : null}
      <span>{brand.name}</span>
    </span>
  );
}

/** 纯品牌名文本（侧栏、导航、按钮文案等复用）。 */
export function BrandName({ className }: { readonly className?: string }) {
  const brand = useBrand();
  return <span className={className}>{brand.name}</span>;
}
