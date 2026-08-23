"use client";

import Link from "next/link";
import { usePathname } from "next/navigation";
import {
  Crosshair,
  FileText,
  FlaskConical,
  LayoutDashboard,
  Microscope,
  Radar,
  Repeat,
} from "lucide-react";

/** 量化面板本身。 */
const primaryNav = [
  { href: "/", label: "总览", icon: LayoutDashboard },
  { href: "/mpr", label: "市场雷达", icon: Radar },
  { href: "/rotation", label: "轮动持仓", icon: Repeat },
  { href: "/depth", label: "个股面板", icon: Microscope },
  { href: "/lab", label: "调参实验室", icon: FlaskConical },
];

/**
 * Discord 推送的内容镜像。
 *
 * /jobs 与 /settings 是运维后台，路由保留但不进导航，直接输 URL 访问。
 */
const secondaryNav = [
  { href: "/screener", label: "每日筛选", icon: Crosshair },
  { href: "/reports", label: "每日简报", icon: FileText },
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
      <span className="mx-2 h-4 w-px bg-[var(--border-subtle)]" />
      {secondaryNav.map((item) => (
        <NavLink key={item.href} {...item} active={isActive(item.href)} muted />
      ))}
    </nav>
  );
}

function NavLink({
  href,
  label,
  icon: Icon,
  active,
  muted,
}: {
  href: string;
  label: string;
  icon: typeof Radar;
  active: boolean;
  muted?: boolean;
}) {
  return (
    <Link
      href={href}
      aria-current={active ? "page" : undefined}
      className={[
        "relative flex items-center gap-1.5 rounded-md px-2.5 py-1.5 transition-colors duration-200",
        active
          ? "bg-[var(--surface-hover)] text-zinc-50"
          : muted
            ? "text-zinc-500 hover:bg-[var(--surface-raised)] hover:text-zinc-200"
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
