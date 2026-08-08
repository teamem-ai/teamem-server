import { BrowserRouter, Routes, Route, Navigate } from "react-router-dom";
import { ThemeProvider } from "@/components/theme-provider";
import { AppShell } from "@/components/layout/app-shell";
import { NotFound } from "@/components/ui/not-found";
import { ComponentShowcase } from "@/pages/component-showcase";
import { KnowledgePage } from "@/pages/knowledge-page";
import { MembersPage } from "@/pages/members-page";
import { MemberProfilePage } from "@/pages/member-profile-page";
import { ConceptDetailPage } from "@/pages/concept-detail-page";
import { ContextPreviewPage } from "@/pages/context-preview-page";
import { EventDetailPage } from "@/pages/event-detail-page";
import { SoonPage } from "@/pages/soon-page";
import { AuditPage } from "@/pages/audit-page";
import { EventsPage } from "@/pages/events-page";
import { JobsPage } from "@/pages/jobs-page";
import { JobDetailPage } from "@/pages/job-detail-page";
import { LoginPage } from "@/pages/login";
import { InvitePage } from "@/pages/invite";
import { AppLanding } from "@/pages/app-landing";
import { OnboardingPage } from "@/components/onboarding/onboarding-page";
import { SettingsLayout } from "@/pages/settings-layout";
import { SettingsKeysPage } from "@/pages/settings-keys-page";
import { SettingsSourcesPage } from "@/pages/settings-sources-page";
import { SettingsLlmPage } from "@/pages/settings-llm-page";
import { SettingsProjectPage } from "@/pages/settings-project-page";
import { SettingsTeamPage } from "@/pages/settings-team-page";

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

          {/* Onboarding wizard — focused flow, no app shell */}
          <Route path="/onboarding" element={<OnboardingPage />} />

          {/* Root → onboarding: the wizard is the front door. Its entry
              guard sorts every arrival — signed-out → GitHub sign-in step,
              onboarded (has a project) → /knowledge, mid-setup → the steps. */}
          <Route path="/" element={<Navigate to="/onboarding" replace />} />

          {/* Main app routes */}
          <Route element={<AppShell />}>
            <Route path="/knowledge" element={<KnowledgePage />} />
            <Route path="/concept/:uuid" element={<ConceptDetailPage />} />
            <Route path="/context-preview" element={<ContextPreviewPage />} />
            <Route path="/events" element={<EventsPage />} />
            <Route path="/events/:id" element={<EventDetailPage />} />
            <Route path="/jobs" element={<JobsPage />} />
            <Route path="/jobs/:id" element={<JobDetailPage />} />
            <Route path="/members" element={<MembersPage />} />
            <Route path="/members/:userId" element={<MemberProfilePage />} />
            <Route path="/audit" element={<AuditPage />} />
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
    </ThemeProvider>
  );
}
