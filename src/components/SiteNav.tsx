"use client";

import Link from "next/link";
import { usePathname } from "next/navigation";
import {
  FlaskConical,
  LayoutDashboard,
  ListChecks,
  Radar,
  Repeat,
  Wallet,
} from "lucide-react";

/** 量化面板本身。 */
const primaryNav = [
  { href: "/", label: "总览", icon: LayoutDashboard },
  { href: "/desk", label: "信号台", icon: ListChecks },
  { href: "/fund", label: "资金账本", icon: Wallet },
  { href: "/mpr", label: "市场雷达", icon: Radar },
  { href: "/rotation", label: "轮动持仓", icon: Repeat },
  { href: "/lab", label: "调参实验室", icon: FlaskConical },
];

export function SiteNav() {
  const pathname = usePathname();
  const isActive = (href: string) =>
    href === "/" ? pathname === "/" : pathname.startsWith(href);

  return (
    <nav className="hidden items-center gap-0.5 text-sm md:flex">
      {primaryNav.map((item) => (
        <NavLink key={item.href} {...item} active={isActive(item.href)} />
      ))}
    </nav>
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
  icon: typeof Radar;
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
