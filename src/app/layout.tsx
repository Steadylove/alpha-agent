import "@/app/globals.css";
import Link from "next/link";
import type { Metadata } from "next";
import type { ReactNode } from "react";
import { Providers } from "@/app/providers";
import { SiteNav } from "@/components/SiteNav";
import Image from "next/image";

export const metadata: Metadata = {
  title: { default: "TREND ADAPTIVE", template: "%s · TREND ADAPTIVE" },
  applicationName: "TREND ADAPTIVE",
  description: "趋势自适应系统 · 市场复盘、期权结构与信号研究。",
};

export default function RootLayout({ children }: { children: ReactNode }) {
  return (
    // 属性在服务端就写死，避免首屏闪一下浅色；Mantine 的样式靠它选中深色变量
    <html lang="zh-CN" data-mantine-color-scheme="dark" suppressHydrationWarning>
      <body>
        <div className="relative min-h-screen text-zinc-50">
          <Providers>
            <header className="site-header">
              <div className="site-header-inner">
                <Link href="/" className="site-brand" aria-label="TREND ADAPTIVE 首页">
                  <Image src="/brand/trend-adaptive.svg" alt="" width={40} height={40} priority />
                  <span>
                    <span className="site-brand-name">TREND ADAPTIVE</span>
                    <span className="site-brand-caption">FOLLOW THE FLOW · TRADE THE TREND</span>
                  </span>
                </Link>
                <SiteNav />
              </div>
            </header>
            <main className="site-main">{children}</main>
          </Providers>
        </div>
      </body>
    </html>
  );
}
