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


/** Top bar: team/project switcher, search, user menu, theme toggle. */
export function Topbar() {
  const { theme, toggleTheme } = useTheme();
  const [userMenuOpen, setUserMenuOpen] = useState(false);
  const menuRef = useRef<HTMLDivElement>(null);

  // Close on outside click
  useEffect(() => {
    function handleClick(e: MouseEvent) {
      if (menuRef.current && !menuRef.current.contains(e.target as Node)) {
        setUserMenuOpen(false);
      }
    }
    document.addEventListener("mousedown", handleClick);
    return () => document.removeEventListener("mousedown", handleClick);
  }, []);

  return (
    <header className="h-topbar border-b border-border bg-bg flex items-center gap-[6px] sm:gap-[10px] px-3 sm:px-6 sticky top-0 z-30 overflow-hidden">
      {/* Team switcher */}
      <button className="switcher inline-flex items-center gap-[7px] font-semibold text-[13px] sm:text-[13.5px] py-[6px] px-[8px] sm:px-[10px] rounded-sm cursor-pointer text-text border border-transparent hover:bg-surface-2 max-w-[100px] sm:max-w-[200px] transition-colors">
        <span
          className="avatar w-[18px] h-[18px] text-[9px]"
          style={{ background: "var(--accent)", color: "#fff" }}
        >
          A
        </span>
        <span className="truncate">Acme Corp</span>
        <ChevronDown className="w-[14px] h-[14px] text-text-3 flex-none" />
      </button>

      <span className="text-text-3 font-normal hidden sm:inline">/</span>

      {/* Project switcher */}
      <button className="switcher inline-flex items-center gap-[7px] font-semibold text-[13px] sm:text-[13.5px] py-[6px] px-[8px] sm:px-[10px] rounded-sm cursor-pointer text-text border border-transparent hover:bg-surface-2 max-w-[100px] sm:max-w-[180px] transition-colors">
        <Box className="w-[15px] h-[15px] text-text-3 flex-none" />
        <span className="truncate">web-app</span>
        <ChevronDown className="w-[14px] h-[14px] text-text-3 flex-none" />
      </button>

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

      {/* User menu */}
      <div className="relative" ref={menuRef}>
        <button
          onClick={() => setUserMenuOpen(!userMenuOpen)}
          className="avatar w-[26px] h-[26px] text-[10.5px] font-semibold text-white cursor-pointer"
          style={{ background: "var(--emerald)" }}
          title="dli · owner"
        >
          DL
        </button>

        {userMenuOpen && (
          <div className="absolute right-0 top-full mt-1 w-48 bg-surface border border-border rounded-lg shadow-lg z-50 py-1">
            <div className="px-3 py-2 border-b border-border">
              <div className="font-semibold text-[13px]">dli</div>
              <div className="text-[11.5px] text-text-3">owner</div>
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
              onClick={() => setUserMenuOpen(false)}
            >
              <LogOut className="w-4 h-4" />
              Sign out
            </button>
          </div>
        )}
      </div>
    </header>
  );
}

