"use client";

import Link from "next/link";
import { Select } from "@mantine/core";
import { usePathname, useRouter } from "next/navigation";
import {
  Bell,
  CalendarDays,
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
  { href: "/catalyst", label: "事件观察", icon: CalendarDays },
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
    <Select aria-label="页面导航" value={primaryNav.find(item => isActive(item.href))?.href ?? "/"}
      onChange={value => { if (value) router.push(value); }}
      data={primaryNav.map(item => ({ value: item.href, label: item.label }))}
      size="xs" className="site-nav-select" />
    <nav aria-label="主导航" className="site-nav">
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
      className="site-nav-link"
    >
      <Icon className="h-4 w-4" />
      <span>{label}</span>

    </Link>
  );
}
