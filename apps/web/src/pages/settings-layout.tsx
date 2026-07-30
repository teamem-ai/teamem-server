import { NavLink, Outlet } from "react-router-dom";
import { cn } from "@/lib/utils";

const tabs = [
  { label: "API keys", to: "/settings/keys" },
  { label: "Ingestion", to: "/settings/sources" },
  { label: "LLM & retrieval", to: "/settings/llm" },
  { label: "Project", to: "/settings/project" },
  { label: "Team", to: "/settings/team" },
] as const;

/** Settings area tab navigation. Renders the outlet for the active tab. */
export function SettingsLayout() {

  return (
    <div>
      <nav className="flex gap-0.5 border-b border-border mb-5 overflow-x-auto">
        {tabs.map((tab) => (
          <NavLink
            key={tab.to}
            to={tab.to}
            className={({ isActive }) =>
              cn(
                "py-[9px] px-[14px] font-medium text-[13.5px] cursor-pointer border-b-2 -mb-px whitespace-nowrap transition-colors",
                isActive
                  ? "text-accent border-accent font-semibold"
                  : "text-text-2 border-transparent hover:text-text"
              )
            }
          >
            {tab.label}
          </NavLink>
        ))}
      </nav>
      <Outlet />
    </div>
  );
}
