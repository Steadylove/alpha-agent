import "@/app/globals.css";
import Link from "next/link";
import type { Metadata } from "next";
import type { ReactNode } from "react";
import { Providers } from "@/app/providers";
import { DbUnavailableNotice } from "@/components/DbUnavailableNotice";
import { SiteNav } from "@/components/SiteNav";
import { Compass } from "lucide-react";

export const metadata: Metadata = {
  title: "Market Compass",
  description: "US equities swing-trading market compass dashboard",
};

export default function RootLayout({ children }: { children: ReactNode }) {
  return (
    // 属性在服务端就写死，避免首屏闪一下浅色；Mantine 的样式靠它选中深色变量
    <html lang="zh-CN" data-mantine-color-scheme="dark" suppressHydrationWarning>
      <body>
        <div className="relative min-h-screen text-zinc-50">
          {/* 顶部一层极淡的光晕，避免整页是一块纯色死黑 */}
          <div
            aria-hidden
            className="pointer-events-none fixed inset-x-0 top-0 h-[420px]"
            style={{
              background:
                "radial-gradient(80% 100% at 50% 0%, rgba(91,141,239,0.07) 0%, rgba(91,141,239,0) 70%)",
            }}
          />
          <Providers>
            <header className="sticky top-0 z-50 border-b border-[var(--border-subtle)] bg-[var(--surface-base)]/80 backdrop-blur-xl">
              <div className="mx-auto flex h-14 max-w-6xl items-center justify-between px-6">
                <Link
                  href="/"
                  className="flex items-center gap-2 text-zinc-100 transition-colors hover:text-white"
                >
                  <Compass className="h-5 w-5" style={{ color: "var(--accent)" }} />
                  <span className="text-sm font-semibold tracking-wide">Market Compass</span>
                </Link>
                <SiteNav />
              </div>
            </header>
            <DbUnavailableNotice />
            <main className="relative mx-auto max-w-6xl px-6 py-10">{children}</main>
          </Providers>
        </div>
      </body>
    </html>
  );
}
