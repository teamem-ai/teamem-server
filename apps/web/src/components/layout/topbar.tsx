import { useState, useRef, useEffect } from "react";
import {
  Search,
  ChevronDown,
  Sun,
  Moon,
  LogOut,
  User,
  Box,
} from "lucide-react";
import { useTheme } from "@/components/theme-provider";
import { useScope } from "@/lib/scope";

/** Top bar: team/project switcher, search, user menu, theme toggle.
 *  Team, project, and user identity all come from the real web session
 *  (via the scope provider) — nothing is hardcoded. */
export function Topbar() {
  const { theme, toggleTheme } = useTheme();
  const scope = useScope();
  const [userMenuOpen, setUserMenuOpen] = useState(false);
  const [projectMenuOpen, setProjectMenuOpen] = useState(false);
  const userMenuRef = useRef<HTMLDivElement>(null);
  const projectMenuRef = useRef<HTMLDivElement>(null);

  // Close menus on outside click
  useEffect(() => {
    function handleClick(e: MouseEvent) {
      if (userMenuRef.current && !userMenuRef.current.contains(e.target as Node)) {
        setUserMenuOpen(false);
      }
      if (projectMenuRef.current && !projectMenuRef.current.contains(e.target as Node)) {
        setProjectMenuOpen(false);
      }
    }
    document.addEventListener("mousedown", handleClick);
    return () => document.removeEventListener("mousedown", handleClick);
  }, []);

  const activeProject = scope.projects.find((p) => p.id === scope.projectId);
  const teamName = scope.teamName ?? "…";
  const login = scope.user?.githubLogin ?? "";
  const role = scope.role ?? "";
  const avatarInitial = login ? login.charAt(0).toUpperCase() : "?";
  const teamInitial = teamName !== "…" ? teamName.charAt(0).toUpperCase() : "…";

  const handleSignOut = async () => {
    try {
      await fetch("/auth/logout", { method: "POST", credentials: "same-origin" });
    } finally {
      window.location.href = "/";
    }
  };

  return (
    <header className="h-topbar border-b border-border bg-bg flex items-center gap-[6px] sm:gap-[10px] px-3 sm:px-6 sticky top-0 z-30 overflow-hidden">
      {/* Team indicator — the session's active team. Multi-team switching is
          not available yet, so this is a label, not a fake switcher. */}
      <span className="inline-flex items-center gap-[7px] font-semibold text-[13px] sm:text-[13.5px] py-[6px] px-[8px] sm:px-[10px] text-text max-w-[100px] sm:max-w-[220px] truncate">
        <span
          className="avatar w-[18px] h-[18px] text-[9px] inline-flex items-center justify-center rounded-full text-white flex-none"
          style={{ background: "var(--accent)" }}
        >
          {teamInitial}
        </span>
        <span className="truncate">{teamName}</span>
      </span>

      <span className="text-text-3 font-normal hidden sm:inline">/</span>

      {/* Project switcher — real projects from the session's team. */}
      <div className="relative" ref={projectMenuRef}>
        <button
          className="switcher inline-flex items-center gap-[7px] font-semibold text-[13px] sm:text-[13.5px] py-[6px] px-[8px] sm:px-[10px] rounded-sm cursor-pointer text-text border border-transparent hover:bg-surface-2 max-w-[100px] sm:max-w-[220px] transition-colors"
          onClick={() => setProjectMenuOpen(!projectMenuOpen)}
          disabled={scope.projects.length === 0}
        >
          <Box className="w-[15px] h-[15px] text-text-3 flex-none" />
          <span className="truncate">{activeProject?.name ?? "No project"}</span>
          {scope.projects.length > 1 && (
            <ChevronDown className="w-[14px] h-[14px] text-text-3 flex-none" />
          )}
        </button>

        {projectMenuOpen && scope.projects.length > 1 && (
          <div className="absolute left-0 top-full mt-1 w-56 bg-surface border border-border rounded-lg shadow-lg z-50 py-1">
            {scope.projects.map((p) => (
              <button
                key={p.id}
                className={`w-full flex items-center gap-2 px-3 py-2 text-[13px] transition-colors ${
                  p.id === scope.projectId
                    ? "bg-accent-soft text-accent font-semibold"
                    : "text-text-2 hover:bg-surface-2 hover:text-text"
                }`}
                onClick={() => {
                  scope.setProjectId(p.id);
                  setProjectMenuOpen(false);
                }}
              >
                <Box className="w-4 h-4" />
                <span className="truncate">{p.name}</span>
              </button>
            ))}
          </div>
        )}
      </div>

      <span className="flex-1" />

      {/* Search button (⌘K placeholder) */}
      <button className="search-btn inline-flex items-center gap-2 border border-border bg-surface text-text-3 rounded-sm py-[6px] px-[10px] text-[13px] cursor-pointer min-w-[40px] sm:min-w-[200px] hover:border-border-strong transition-colors">
        <Search className="w-4 h-4 flex-none" />
        <span className="hidden sm:inline">Search knowledge…</span>
        <kbd className="ml-auto font-medium text-[11px] font-mono bg-surface-2 border border-border rounded px-[5px] py-px text-text-2 hidden sm:inline">
          ⌘K
        </kbd>
      </button>

      {/* Theme toggle */}
      <button
        onClick={toggleTheme}
        className="p-2 rounded-sm text-text-3 hover:bg-surface-2 hover:text-text transition-colors"
        aria-label={`Switch to ${theme === "light" ? "dark" : "light"} theme`}
      >
        {theme === "light" ? (
          <Moon className="w-4 h-4" />
        ) : (
          <Sun className="w-4 h-4" />
        )}
      </button>

      {/* User menu — real session identity. */}
      {scope.user && (
        <div className="relative" ref={userMenuRef}>
          <button
            onClick={() => setUserMenuOpen(!userMenuOpen)}
            className="avatar w-[26px] h-[26px] text-[10.5px] font-semibold text-white cursor-pointer inline-flex items-center justify-center rounded-full overflow-hidden"
            style={{ background: "var(--emerald)" }}
            title={`${login} · ${role}`}
          >
            {scope.user.avatarUrl ? (
              <img
                src={scope.user.avatarUrl}
                alt={login}
                className="w-full h-full object-cover"
              />
            ) : (
              avatarInitial
            )}
          </button>

          {userMenuOpen && (
            <div className="absolute right-0 top-full mt-1 w-48 bg-surface border border-border rounded-lg shadow-lg z-50 py-1">
              <div className="px-3 py-2 border-b border-border">
                <div className="font-semibold text-[13px]">{login}</div>
                <div className="text-[11.5px] text-text-3">{role}</div>
              </div>
              <button
                className="w-full flex items-center gap-2 px-3 py-2 text-[13px] text-text-2 hover:bg-surface-2 hover:text-text transition-colors"
                onClick={() => setUserMenuOpen(false)}
              >
                <User className="w-4 h-4" />
                Profile
              </button>
              <button
                className="w-full flex items-center gap-2 px-3 py-2 text-[13px] text-text-2 hover:bg-surface-2 hover:text-text transition-colors"
                onClick={handleSignOut}
              >
                <LogOut className="w-4 h-4" />
                Sign out
              </button>
            </div>
          )}
        </div>
      )}
    </header>
  );
}
