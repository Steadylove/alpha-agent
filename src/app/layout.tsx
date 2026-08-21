import "@/app/globals.css";
import Link from "next/link";
import type { Metadata } from "next";
import type { ReactNode } from "react";
import { Providers } from "@/app/providers";
import { ColorSchemeScript } from "@mantine/core";
import { Compass, LayoutDashboard, FileText, Crosshair, Radar, Repeat, Microscope } from "lucide-react";

export const metadata: Metadata = {
  title: "Market Compass",
  description: "US equities swing-trading market compass dashboard",
};

/** 量化面板本身。 */
const primaryNav = [
  { href: "/", label: "Overview", icon: LayoutDashboard },
  { href: "/mpr", label: "Radar", icon: Radar },
  { href: "/rotation", label: "Rotation", icon: Repeat },
  { href: "/depth", label: "Depth", icon: Microscope },
];

/**
 * Discord 推送的内容镜像。
 *
 * /jobs 与 /settings 是运维后台，路由保留但不进导航，直接输 URL 访问。
 */
const secondaryNav = [
  { href: "/screener", label: "Screener", icon: Crosshair },
  { href: "/reports", label: "Reports", icon: FileText },
];

export default function RootLayout({ children }: { children: ReactNode }) {
  return (
    <html lang="zh-CN">
      <head>
        <ColorSchemeScript defaultColorScheme="dark" />
      </head>
      <body>
        <Providers>
          <div className="min-h-screen bg-[#09090b] text-zinc-50">
            <header className="sticky top-0 z-50 border-b border-zinc-800 bg-[#09090b]">
              <div className="mx-auto flex h-14 max-w-6xl items-center justify-between px-6">
                <Link href="/" className="flex items-center gap-2 text-zinc-100 hover:text-white transition-colors">
                  <Compass className="h-5 w-5" />
                  <span className="text-sm font-semibold tracking-wide">Market Compass</span>
                </Link>
                <nav className="hidden items-center gap-5 text-sm text-zinc-400 md:flex">
                  {primaryNav.map((item) => (
                    <Link key={item.href} href={item.href} className="flex items-center gap-2 hover:text-zinc-50 transition-colors">
                      <item.icon className="h-4 w-4" />
                      <span>{item.label}</span>
                    </Link>
                  ))}
                  <span className="h-4 w-px bg-zinc-800" />
                  {secondaryNav.map((item) => (
                    <Link key={item.href} href={item.href} className="flex items-center gap-2 text-zinc-500 hover:text-zinc-200 transition-colors">
                      <item.icon className="h-4 w-4" />
                      <span>{item.label}</span>
                    </Link>
                  ))}
                </nav>
              </div>
            </header>
            <main className="mx-auto max-w-6xl px-6 py-8">{children}</main>
          </div>
        </Providers>
      </body>
    </html>
  );
}
