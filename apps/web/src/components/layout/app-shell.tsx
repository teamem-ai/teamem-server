import { Outlet } from "react-router-dom";
import { Sidebar } from "./sidebar";
import { Topbar } from "./topbar";
import { ScopeProvider } from "@/lib/scope";

/** Main app shell: sidebar + topbar + content area.
 *  All authenticated pages reuse this layout. The scope provider resolves
 *  the real team/project/role from the web session for every child page. */
export function AppShell() {
  return (
    <ScopeProvider>
      <div className="app-shell flex min-h-screen flex-col lg:flex-row">
        <Sidebar />
        <div className="flex-1 min-w-0 flex flex-col lg:ml-sidebar">
          <Topbar />
          <main className="flex-1 px-4 sm:px-6 lg:px-8 py-6 lg:py-7 max-w-[1180px] w-full mx-auto">
            <Outlet />
          </main>
        </div>
      </div>
    </ScopeProvider>
  );
}
