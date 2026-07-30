import { BrowserRouter, Routes, Route, Navigate } from "react-router-dom";
import { ThemeProvider } from "@/components/theme-provider";
import { AppShell } from "@/components/layout/app-shell";
import { NotFound } from "@/components/ui/not-found";
import { ComponentShowcase } from "@/pages/component-showcase";
import { KnowledgePage } from "@/pages/knowledge-page";
import { SoonPage } from "@/pages/soon-page";
import { PlaceholderPage } from "@/pages/placeholder-page";
import { LoginPage } from "@/pages/login";
import { InvitePage } from "@/pages/invite";
import { AppLanding } from "@/pages/app-landing";

export default function App() {
  return (
    <ThemeProvider>
      <BrowserRouter>
        <Routes>
          {/* Public auth entry pages (no AppShell) */}
          <Route path="/login" element={<LoginPage />} />
          <Route path="/join" element={<InvitePage />} />
          <Route path="/app" element={<AppLanding />} />

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
            <Route
              path="/settings/keys"
              element={
                <PlaceholderPage
                  title="API keys"
                  description="Mint and manage API keys for agents and CLI access."
                />
              }
            />
            <Route
              path="/settings/sources"
              element={
                <PlaceholderPage
                  title="Ingestion sources"
                  description="GitHub App, CLI, and MCP connection status."
                />
              }
            />
            <Route
              path="/settings/llm"
              element={
                <PlaceholderPage
                  title="LLM & retrieval"
                  description="Configure your LLM provider and check semantic search status."
                />
              }
            />
            <Route
              path="/settings/project"
              element={
                <PlaceholderPage
                  title="Project settings"
                  description="General settings and danger zone."
                />
              }
            />
            <Route
              path="/settings/team"
              element={
                <PlaceholderPage
                  title="Team settings"
                  description="Manage your team configuration."
                />
              }
            />
          </Route>

          {/* 404 — must be last */}
          <Route path="*" element={<AppShell />}>
            <Route path="*" element={<NotFound />} />
          </Route>
        </Routes>
      </BrowserRouter>
    </ThemeProvider>
  );
}
