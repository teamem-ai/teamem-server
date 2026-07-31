import { Outlet } from "react-router-dom";
import { Sidebar } from "./sidebar";
import { Topbar } from "./topbar";

/** Main app shell: sidebar + topbar + content area.
 *  All authenticated pages reuse this layout. */
export function AppShell() {
  return (
    <div className="app-shell flex min-h-screen lg:flex-row flex-col">
      <Sidebar />
      <div className="flex-1 lg:ml-sidebar min-w-0 flex flex-col">
        <Topbar />
        <main className="flex-1 px-4 sm:px-6 lg:px-8 py-6 lg:py-7 max-w-[1180px] w-full mx-auto">
          <Outlet />
        </main>
      </div>
    </div>
  );
}
