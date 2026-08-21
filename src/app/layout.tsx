import "@/app/globals.css";
import Link from "next/link";
import type { Metadata } from "next";
import type { ReactNode } from "react";
import { Providers } from "@/app/providers";
import { ColorSchemeScript } from "@mantine/core";
import { Compass, LayoutDashboard, LineChart, FileText, Activity, Settings, BookOpen, Crosshair, Radar, Repeat } from "lucide-react";

export const metadata: Metadata = {
  title: "Market Compass",
  description: "US equities swing-trading market compass dashboard",
};

const navItems = [
  { href: "/", label: "Overview", icon: LayoutDashboard },
  { href: "/mpr", label: "Radar", icon: Radar },
  { href: "/rotation", label: "Rotation", icon: Repeat },
  { href: "/screener", label: "Screener", icon: Crosshair },
  { href: "/stocks", label: "Universe", icon: LineChart },
  { href: "/reports", label: "Reports", icon: FileText },
  { href: "/methodology", label: "Methodology", icon: BookOpen },
  { href: "/jobs", label: "Runs", icon: Activity },
  { href: "/settings", label: "Config", icon: Settings },
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
                <nav className="hidden items-center gap-6 text-sm text-zinc-400 md:flex">
                  {navItems.map((item) => (
                    <Link key={item.href} href={item.href} className="flex items-center gap-2 hover:text-zinc-50 transition-colors">
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
