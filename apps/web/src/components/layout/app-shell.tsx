import { Outlet, Navigate } from "react-router-dom";
import { Sidebar } from "./sidebar";
import { Topbar } from "./topbar";
import { ScopeProvider, useScope } from "@/lib/scope";

/** Redirects to /login once the scope resolves to "signed-out" — e.g. after
 *  the session cookie is cleared (sign out) or expires. Must render inside
 *  ScopeProvider so useScope() has a context to read. "loading" is left
 *  alone (the initial fetch hasn't settled yet, not an auth decision), and
 *  "error" is left to the page-level retry UI (a fetch/network failure is
 *  not the same thing as being signed out). */
function AppShellContent() {
  const scope = useScope();

  if (scope.status === "signed-out") {
    return <Navigate to="/login" replace />;
  }

  return (
    <div className="app-shell flex min-h-screen flex-col lg:flex-row">
      <Sidebar />
      <div className="flex-1 ml-sidebar min-w-0 flex flex-col main-resp">
        <Topbar />
        <main className="flex-1 px-4 sm:px-6 lg:px-8 py-6 lg:py-7 max-w-[1180px] w-full mx-auto">
          <Outlet />
        </main>
      </div>
    </div>
  );
}

/** Main app shell: sidebar + topbar + content area.
 *  All authenticated pages reuse this layout. The scope provider resolves
 *  the real team/project/role from the web session for every child page,
 *  and AppShellContent redirects to /login the moment that resolution
 *  comes back signed-out — this is the single place that covers every
 *  route nested under AppShell, instead of each page having to remember
 *  to check scope.status itself. */
export function AppShell() {
  return (
    <ScopeProvider>
      <AppShellContent />
    </ScopeProvider>
  );
}
