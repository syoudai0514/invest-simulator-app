"use client";

import Link from "next/link";
import { usePathname } from "next/navigation";
import { cn } from "@/lib/utils";
import { LineChart, Wallet, History, Settings } from "lucide-react";

const links = [
  { href: "/", label: "ダッシュボード", icon: Wallet },
  { href: "/trade", label: "売買・チャート", icon: LineChart },
  { href: "/history", label: "取引履歴", icon: History },
  { href: "/settings", label: "設定", icon: Settings },
];

export function Nav() {
  const pathname = usePathname();
  return (
    <header className="border-b bg-card/50 backdrop-blur sticky top-0 z-10">
      <div className="mx-auto max-w-6xl px-4 flex items-center gap-1 h-14">
        <span className="font-bold text-lg mr-4 flex items-center gap-2">
          <LineChart className="h-5 w-5 text-emerald-500" />
          Invest<span className="text-emerald-500">Sim</span>
        </span>
        <nav className="flex items-center gap-1">
          {links.map(({ href, label, icon: Icon }) => {
            const active =
              href === "/" ? pathname === "/" : pathname.startsWith(href);
            return (
              <Link
                key={href}
                href={href}
                className={cn(
                  "flex items-center gap-1.5 rounded-md px-3 py-1.5 text-sm font-medium transition-colors",
                  active
                    ? "bg-emerald-500/10 text-emerald-600 dark:text-emerald-400"
                    : "text-muted-foreground hover:text-foreground hover:bg-muted",
                )}
              >
                <Icon className="h-4 w-4" />
                <span className="hidden sm:inline">{label}</span>
              </Link>
            );
          })}
        </nav>
      </div>
    </header>
  );
}
