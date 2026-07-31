import type { Metadata } from "next";
import Script from "next/script";
import "./globals.css";

export const metadata: Metadata = {
  title: "SnowHarness",
  description: "AI 驱动的「从想法到上线」工作台",
};

/**
 * P2 修复（12 Studio P2-2）：暗色模式防 FOUC。
 * 在首帧渲染前同步读 localStorage 主题。Desktop 未设置时使用方案规定的浅色，
 * 其他页面仍跟随 prefers-color-scheme；明确保存的用户选择始终优先。
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
