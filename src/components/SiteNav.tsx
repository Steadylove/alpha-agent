"use client";

import Link from "next/link";
import { usePathname, useRouter } from "next/navigation";
import {
  Bell,
  FlaskConical,
  Layers,
  LayoutDashboard,
  ListChecks,
  ScanLine,
  Wallet,
} from "lucide-react";

/** 量化面板本身。 */
const primaryNav = [
  { href: "/", label: "每日复盘", icon: LayoutDashboard },
  { href: "/desk", label: "信号台", icon: ListChecks },
  { href: "/fund", label: "资金账本", icon: Wallet },
  { href: "/opportunity", label: "机会", icon: Layers },
  { href: "/flow", label: "期权流研究", icon: ScanLine },
  { href: "/lab", label: "调参实验室", icon: FlaskConical },
  { href: "/push", label: "推送", icon: Bell },
];

export function SiteNav() {
  const pathname = usePathname();
  const router = useRouter();
  const isActive = (href: string) =>
    href === "/" ? pathname === "/" || pathname === "/review" : pathname.startsWith(href);

  return (
    <>
    <select aria-label="页面导航" value={primaryNav.find(item => isActive(item.href))?.href ?? "/"}
      onChange={event => router.push(event.target.value)}
      className="max-w-28 rounded border border-white/10 bg-[var(--surface-base)] px-2 py-1.5 text-xs text-zinc-300 md:hidden">
      {primaryNav.map(item => <option key={item.href} value={item.href}>{item.label}</option>)}
    </select>
    <nav className="hidden items-center gap-0.5 text-sm md:flex">
      {primaryNav.map((item) => (
        <NavLink key={item.href} {...item} active={isActive(item.href)} />
      ))}
    </nav>
    </>
  );
}

function NavLink({
  href,
  label,
  icon: Icon,
  active,
}: {
  href: string;
  label: string;
  icon: typeof ScanLine;
  active: boolean;
}) {
  return (
    <Link
      href={href}
      aria-current={active ? "page" : undefined}
      className={[
        "relative flex items-center gap-1.5 rounded-md px-2.5 py-1.5 transition-colors duration-200",
        active
          ? "bg-[var(--surface-hover)] text-zinc-50"
          : "text-zinc-400 hover:bg-[var(--surface-raised)] hover:text-zinc-50",
      ].join(" ")}
    >
      <Icon className="h-4 w-4" />
      <span>{label}</span>
      {active ? (
        <span className="absolute inset-x-2.5 -bottom-1.5 h-px bg-[var(--accent)]" />
      ) : null}
    </Link>
  );
}
