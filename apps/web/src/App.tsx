import { BrowserRouter, Routes, Route, Navigate } from "react-router-dom";
import { ThemeProvider } from "@/components/theme-provider";
import { SessionProvider } from "@/lib/session";
import { AppShell } from "@/components/layout/app-shell";
import { NotFound } from "@/components/ui/not-found";
import { ComponentShowcase } from "@/pages/component-showcase";
import { KnowledgePage } from "@/pages/knowledge-page";
import { SoonPage } from "@/pages/soon-page";
import { PlaceholderPage } from "@/pages/placeholder-page";
import { SettingsLayout } from "@/pages/settings-layout";
import { SettingsKeysPage } from "@/pages/settings-keys-page";
import { SettingsSourcesPage } from "@/pages/settings-sources-page";
import { SettingsLlmPage } from "@/pages/settings-llm-page";
import { SettingsProjectPage } from "@/pages/settings-project-page";
import { SettingsTeamPage } from "@/pages/settings-team-page";

export default function App() {
  return (
    <ThemeProvider>
      <SessionProvider value={{ teamId: null, role: null, projectId: null }}>
      <BrowserRouter>
        <Routes>
          {/* Component showcase (design system self-check) */}
          <Route path="/components" element={<AppShell />}>
            <Route index element={<ComponentShowcase />} />
          </Route>

          {/* Redirect root to knowledge */}
          <Route path="/" element={<Navigate to="/knowledge" replace />} />

          {/* Main app routes */}
          <Route element={<AppShell />}>
            <Route path="/knowledge" element={<KnowledgePage />} />
            <Route
              path="/context-preview"
              element={
                <PlaceholderPage
                  title="Context preview"
                  description="Preview what your agent sees at the start of each session."
                />
              }
            />
            <Route
              path="/events"
              element={
                <PlaceholderPage
                  title="Events"
                  description="Raw development activity ingested from your sources."
                />
              }
            />
            <Route
              path="/jobs"
              element={
                <PlaceholderPage
                  title="Jobs"
                  description="Compile jobs that turn events into knowledge pages."
                />
              }
            />
            <Route
              path="/members"
              element={
                <PlaceholderPage
                  title="Members"
                  description="Team members and their roles."
                />
              }
            />
            <Route
              path="/audit"
              element={
                <PlaceholderPage
                  title="Audit log"
                  description="Who read what, and when. Metadata only — query text and payloads are never stored."
                />
              }
            />
            <Route path="/soon" element={<SoonPage />} />
            {/* Settings area with shared tab layout */}
            <Route path="/settings" element={<SettingsLayout />}>
              <Route index element={<Navigate to="/settings/keys" replace />} />
              <Route path="keys" element={<SettingsKeysPage />} />
              <Route path="sources" element={<SettingsSourcesPage />} />
              <Route path="llm" element={<SettingsLlmPage />} />
              <Route path="project" element={<SettingsProjectPage />} />
              <Route path="team" element={<SettingsTeamPage />} />
            </Route>
          </Route>

          {/* 404 — must be last */}
          <Route path="*" element={<AppShell />}>
            <Route path="*" element={<NotFound />} />
          </Route>
        </Routes>
      </BrowserRouter>
      </SessionProvider>
    </ThemeProvider>
  );
}
