"use client";

import { useBrand } from "@/components/brand/brand-provider";
import { BrandName } from "@/components/brand/brand-wordmark";
import type { ReactNode } from "react";

/** 登录与首次设密共用品牌、表单宽度和响应式布局。 */
export function AuthScreenLayout({
  title,
  children,
}: {
  readonly title: string;
  readonly children: ReactNode;
}) {
  const brand = useBrand();
  return (
    <main className="flex min-h-dvh items-center overflow-auto bg-background px-[clamp(1.5rem,6vw,6rem)] py-[clamp(2.5rem,10vh,7rem)] text-foreground">
      <section
        aria-label={`${brand.name} ${title}`}
        className="mx-auto grid w-full max-w-5xl items-center gap-[clamp(3rem,6vw,5rem)] md:grid-cols-2"
      >
        <p className="font-semibold text-[clamp(1.5rem,2.6vw,2.25rem)] tracking-[-0.04em]">
          <BrandName />
        </p>
        <div className="w-full max-w-[28rem] md:justify-self-end">{children}</div>
      </section>
    </main>
  );
}
