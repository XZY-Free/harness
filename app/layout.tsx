import type { Metadata } from "next";
import Script from "next/script";
import "./globals.css";

export const metadata: Metadata = {
  title: "SnowHarness",
  description: "AI 驱动的「从想法到上线」工作台",
};

/**
 * P2 修复（12 Studio P2-2）：暗色模式防 FOUC。
 * 在首帧渲染前同步读 localStorage 主题。员工 Web 与 Desktop 始终使用浅色；Studio
 * 默认使用浅色并尊重已保存的显式选择，Studio 的保存值不污染员工界面。
 */
export default function RootLayout({ children }: Readonly<{ children: React.ReactNode }>) {
  return (
    <html lang="zh-CN" suppressHydrationWarning>
      <head />
      <body>
        <Script id="theme-init" src="/theme-init.js" strategy="beforeInteractive" />
        {children}
      </body>
    </html>
  );
}
