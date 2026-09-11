import { BrandInitial } from "@/components/brand/brand-initial";
import type { Metadata } from "next";
import Script from "next/script";
import "./globals.css";

/**
 * 品牌化元数据：标题/描述/图标来自 BrandStore（DB 主存储 + pin 层）。
 * build 期或品牌源不可用时回退代码默认品牌，保证构建不因品牌源失败。
 */
export async function generateMetadata(): Promise<Metadata> {
  const { DEFAULT_BRAND } = await import("@/lib/branding/brand-contract");
  const { getBrandStore } = await import("@/lib/branding/brand-store");
  const snapshot = await getBrandStore()
    .get()
    .catch(() => null);
  const contract = snapshot?.contract ?? DEFAULT_BRAND;
  return {
    title: contract.name,
    description: contract.tagline ?? "AI 驱动的「从想法到上线」工作台",
    ...(contract.icon ? { icons: [{ url: contract.icon }] } : {}),
  };
}

/**
 * P2 修复（12 Studio P2-2）：暗色模式防 FOUC。
 * 在首帧渲染前同步读 localStorage 主题。员工 Web 与 Desktop 始终使用浅色；Studio
 * 默认使用浅色并尊重已保存的显式选择，Studio 的保存值不污染员工界面。
 */
export default function RootLayout({ children }: Readonly<{ children: React.ReactNode }>) {
  const basePath = process.env.NEXT_PUBLIC_SNOW_BASE_PATH ?? "";

  return (
    <html lang="zh-CN" suppressHydrationWarning>
      <head />
      <body>
        <Script id="theme-init" src={`${basePath}/theme-init.js`} strategy="beforeInteractive" />
        <BrandInitial>{children}</BrandInitial>
      </body>
    </html>
  );
}
