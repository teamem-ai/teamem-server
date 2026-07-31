import { NavLink } from "react-router-dom";
import { cn } from "@/lib/utils";
import { SoonBadge } from "@/components/ui/soon-badge";
import {
  BookOpen,
  Sparkles,
  Activity,
  Cpu,
  Users,
  Shield,
  Mail,
  Settings,
  type LucideIcon,
} from "lucide-react";

interface NavGroup {
  label: string;
  items: NavItem[];
}

interface NavItem {
  icon: LucideIcon;
  label: string;
  to: string;
  soon?: boolean;
}

const navGroups: NavGroup[] = [
  {
    label: "Knowledge",
    items: [
      { icon: BookOpen, label: "Knowledge", to: "/knowledge" },
      { icon: Sparkles, label: "Context preview", to: "/context-preview" },
    ],
  },
  {
    label: "Activity",
    items: [
      { icon: Activity, label: "Events", to: "/events" },
      { icon: Cpu, label: "Jobs", to: "/jobs" },
    ],
  },
  {
    label: "Team",
    items: [
      { icon: Users, label: "Members", to: "/members" },
      { icon: Shield, label: "Audit", to: "/audit" },
      { icon: Mail, label: "Team digest", to: "/soon", soon: true },
    ],
  },
  {
    label: "Settings",
    items: [{ icon: Settings, label: "Settings", to: "/settings/keys" }],
  },
];

export function Sidebar() {
  return (
    <aside className="static top-0 w-full bg-surface border-b border-border flex flex-col z-40 lg:fixed lg:left-0 lg:top-0 lg:bottom-0 lg:w-sidebar lg:border-r lg:border-b-0 sidebar-resp">
      {/* Brand */}
      <div className="flex items-center gap-[9px] px-4 py-[14px] font-bold text-[15px] tracking-[-0.02em]">
        <svg
          className="w-[26px] h-[26px] flex-none"
          viewBox="0 0 32 32"
          fill="none"
          xmlns="http://www.w3.org/2000/svg"
          aria-label="teamem logo"
        >
          <rect
            className="fill-accent"
            x="1.5"
            y="1.5"
            width="29"
            height="29"
            rx="7.5"
          />
          <path
            d="M9 11h14M9 16h10.5M9 21h12.5"
            stroke="#fff"
            strokeWidth="2.4"
            strokeLinecap="round"
          />
        </svg>
        teamem
      </div>

      {/* Nav groups */}
      <nav className="flex-1 overflow-y-auto px-[10px] pb-4 pt-1">
        {navGroups.map((group, gi) => (
          <div key={gi}>
            <div className="font-semibold text-[11px] leading-none tracking-[0.07em] text-text-3 uppercase px-[10px] pt-4 pb-[6px]">
              {group.label}
            </div>
            {group.items.map((item, ii) =>
              item.soon ? (
                <div
                  key={ii}
                  className="flex items-center gap-[9px] py-[7px] px-[10px] my-px rounded-sm font-medium text-[13.5px] text-text-3 cursor-not-allowed"
                  title="Coming soon"
                >
                  <item.icon className="w-[17px] h-[17px]" />
                  {item.label}
                  <SoonBadge className="ml-auto" />
                </div>
              ) : (
                <NavLink
                  key={ii}
                  to={item.to}
                  className={({ isActive }) =>
                    cn(
                      "flex items-center gap-[9px] py-[7px] px-[10px] my-px rounded-sm font-medium text-[13.5px] transition-colors relative",
                      isActive
                        ? "bg-accent-soft text-accent font-semibold"
                        : "text-text-2 hover:bg-surface-2 hover:text-text"
                    )
                  }
                >
                  <item.icon className="w-[17px] h-[17px]" />
                  {item.label}
                </NavLink>
              )
            )}
          </div>
        ))}
      </nav>

      {/* Footer */}
      <div className="border-t border-border px-[14px] py-[10px] text-xs text-text-3 flex items-center gap-2">
        <span
          className="w-[7px] h-[7px] rounded-full flex-none"
          style={{ background: "var(--green)" }}
        />
        portal v0.2.0 · self-hosted
      </div>
    </aside>
  );
}
