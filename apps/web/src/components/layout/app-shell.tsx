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
      <div className="flex min-h-screen">
        <Sidebar />
        {/* md:ml-sidebar offsets the fixed 252px sidebar; on small screens the
            sidebar is hidden so content is never overlapped or scrolled. */}
        <div className="flex-1 md:ml-sidebar min-w-0 flex flex-col">
          <Topbar />
          <main className="flex-1 px-8 py-7 max-w-[1180px] w-full mx-auto">
            <Outlet />
          </main>
        </div>
      </div>
    </ScopeProvider>
  );
}
