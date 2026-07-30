import { useState, useEffect, useCallback } from "react";
import { Link, useParams } from "react-router-dom";
import {
  ArrowLeft,
  ExternalLink,
  Github,
  FileQuestion,
  Info,
} from "lucide-react";
import { RoleBadge, EmptyState, TypeBadge, ConfidenceMeter, Skeleton } from "@/components/ui";
import type { Role } from "@/components/ui";
import type { ConceptType } from "@/components/ui";
import type { ConfidenceLevel } from "@/components/ui";
import {
  fetchMembers,
  fetchCurrentUser,
  fetchMemberConcepts,
  ApiRequestError,
  type MemberEntry,
  type ConceptSummary,
} from "@/lib/api";

// ── MemberAvatar ────────────────────────────────────────────────────────────

function MemberAvatar({
  login,
  avatarUrl,
  size = 64,
  fontSize = 24,
}: {
  login: string;
  avatarUrl: string | null;
  size?: number;
  fontSize?: number;
}) {
  const initials = login
    .split(/[.-]/)
    .slice(0, 2)
    .map((p) => (p[0] ?? "").toUpperCase())
    .join("");

  const colors = [
    "var(--accent)",
    "var(--violet)",
    "var(--sky)",
    "var(--emerald)",
    "var(--rose)",
    "var(--amber)",
    "var(--blue)",
  ];
  let hash = 0;
  for (let i = 0; i < login.length; i++) {
    hash = login.charCodeAt(i) + ((hash << 5) - hash);
  }
  const color = colors[Math.abs(hash) % colors.length]!;

  if (avatarUrl) {
    return (
      <img
        src={avatarUrl}
        alt={login}
        className="rounded-full flex-none object-cover"
        style={{ width: size, height: size }}
        referrerPolicy="no-referrer"
      />
    );
  }

  return (
    <span
      className="avatar flex items-center justify-center text-white font-semibold"
      style={{
        width: size,
        height: size,
        fontSize,
        background: color,
      }}
    >
      {initials}
    </span>
  );
}

// ── ConceptRow (reused from knowledge page pattern) ─────────────────────────

function ConceptRow({ concept }: { concept: ConceptSummary }) {
  return (
    <Link
      to={`/concepts/${concept.uuid}`}
      className="krow"
      style={{ color: "inherit", textDecoration: "none" }}
    >
      <div className="k-main">
        <div className="k-title">
          <TypeBadge type={concept.type as ConceptType} />
          <span>{concept.title}</span>
        </div>
        <div className="k-meta">
          <span className="path">{concept.path}</span>
          <span>{concept.tags.length} tag{concept.tags.length !== 1 ? "s" : ""}</span>
          <span>
            Last confirmed{" "}
            {formatRelative(concept.lastConfirmed)}
          </span>
        </div>
      </div>
      <div className="k-side">
        <ConfidenceMeter level={concept.confidence as ConfidenceLevel} />
      </div>
    </Link>
  );
}

// ── Helpers ─────────────────────────────────────────────────────────────────

function formatRelative(iso: string): string {
  const d = new Date(iso);
  const now = Date.now();
  const diff = now - d.getTime();
  const mins = Math.floor(diff / 60000);
  if (mins < 1) return "just now";
  if (mins < 60) return `${mins}m ago`;
  const hours = Math.floor(mins / 60);
  if (hours < 24) return `${hours}h ago`;
  const days = Math.floor(hours / 24);
  if (days < 7) return `${days}d ago`;
  if (days < 30) return `${Math.floor(days / 7)}w ago`;
  return d.toLocaleDateString("en-US", {
    month: "short",
    day: "numeric",
    year: "numeric",
  });
}

function formatJoined(iso: string): string {
  const d = new Date(iso);
  return d.toLocaleDateString("en-US", {
    month: "long",
    day: "numeric",
    year: "numeric",
  });
}

// ── MemberProfilePage ───────────────────────────────────────────────────────

export function MemberProfilePage() {
  const { userId } = useParams<{ userId: string }>();

  const [member, setMember] = useState<MemberEntry | null>(null);
  const [concepts, setConcepts] = useState<ConceptSummary[]>([]);
  const [loading, setLoading] = useState(true);
  const [conceptsLoading, setConceptsLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [projectId, setProjectId] = useState<string | null>(null);

  // ── Load member data ──────────────────────────────────────────────────
  const loadMember = useCallback(async () => {
    if (!userId) return;
    setLoading(true);
    setError(null);
    try {
      const [membersData, userData] = await Promise.all([
        fetchMembers(),
        fetchCurrentUser(),
      ]);
      const found = membersData.find((m) => m.userId === userId);
      if (!found) {
        setError("Member not found");
        setLoading(false);
        return;
      }
      setMember(found);

      // Extract projectId from the user's team info.
      // Since the frontend doesn't yet have a project switcher, we need
      // to query the user's projects. For now, we'll use the team's
      // first project. In a full implementation, this would come from
      // the Topbar's project switcher context.
      if (userData.teamId) {
        // Try to get projects for the team
        try {
          const projectsRes = await fetch(
            `/teams/${userData.teamId}/projects`,
            { credentials: "same-origin" },
          );
          if (projectsRes.ok) {
            const projectsJson = await projectsRes.json();
            if (
              projectsJson.data &&
              Array.isArray(projectsJson.data) &&
              projectsJson.data.length > 0
            ) {
              const firstProject = projectsJson.data[0] as { id: string };
              setProjectId(firstProject.id);
            }
          }
        } catch {
          // Projects endpoint might not be available; that's OK
        }
      }
    } catch (err) {
      if (err instanceof ApiRequestError) {
        if (err.status === 401) {
          setError("You need to sign in to view this page.");
        } else if (err.status === 404) {
          setError("Member not found");
        } else {
          setError(err.apiError?.message ?? err.message);
        }
      } else {
        setError("Failed to load member profile");
      }
    } finally {
      setLoading(false);
    }
  }, [userId]);

  // ── Load contributed concepts ──────────────────────────────────────────
  useEffect(() => {
    if (!member || !projectId) {
      setConceptsLoading(false);
      return;
    }
    setConceptsLoading(true);
    fetchMemberConcepts(member.userId, projectId)
      .then((res) => setConcepts(res.data))
      .catch(() => setConcepts([]))
      .finally(() => setConceptsLoading(false));
  }, [member, projectId]);

  useEffect(() => {
    loadMember();
  }, [loadMember]);

  // ── Render ──────────────────────────────────────────────────────────────

  return (
    <div>
      {/* Back link */}
      <Link
        to="/members"
        className="btn btn-ghost btn-sm mb-[14px] inline-flex items-center gap-1.5"
      >
        <ArrowLeft className="w-[15px] h-[15px]" />
        Members
      </Link>

      {/* Error state */}
      {error && !loading && (
        <div className="card">
          <EmptyState
            icon={FileQuestion}
            title={error === "Member not found" ? "Not found" : "Error"}
            description={
              error === "Member not found"
                ? "This page doesn't exist, or the link is out of date."
                : error
            }
            actions={
              <Link to="/members" className="btn btn-primary">
                Back to Members
              </Link>
            }
          />
        </div>
      )}

      {/* Loading state */}
      {loading && (
        <div className="space-y-[16px]">
          <div className="card card-pad">
            <div className="flex gap-[18px] items-center">
              <Skeleton className="w-[64px] h-[64px] rounded-full" />
              <div className="flex-1">
                <Skeleton className="h-[20px] w-[180px]" />
                <Skeleton className="h-[14px] w-[240px] mt-[8px]" />
              </div>
            </div>
          </div>
          <Skeleton className="h-[15px] w-[180px]" />
          <div className="card py-[6px] px-5">
            <ConceptRowSkeletonComponent />
            <ConceptRowSkeletonComponent />
          </div>
        </div>
      )}

      {/* Profile content */}
      {!loading && !error && member && (
        <>
          {/* Profile header card */}
          <div className="card card-pad mb-[16px]">
            <div className="flex gap-[18px] items-center">
              <MemberAvatar
                login={member.githubLogin}
                avatarUrl={member.avatarUrl}
              />
              <div className="flex-1 min-w-0">
                <h1 className="text-[20px] font-semibold flex items-center gap-[10px]">
                  {member.principalDisplayLogin ?? member.githubLogin}
                  <a
                    href={`https://github.com/${member.githubLogin}`}
                    target="_blank"
                    rel="noopener noreferrer"
                    className="btn btn-ghost btn-sm inline-flex items-center gap-1"
                    title="Open GitHub profile"
                  >
                    <Github className="w-[14px] h-[14px]" />
                    <ExternalLink className="w-[10px] h-[10px]" />
                  </a>
                </h1>
                <div className="flex items-center gap-[10px] mt-[8px]">
                  <RoleBadge role={member.role as Role} />
                  <span className="text-[13px] text-text-2">
                    Joined {formatJoined(member.joinedAt)}
                  </span>
                </div>
              </div>
            </div>
          </div>

          {/* Contributed pages heading */}
          <h2 className="text-[15px] font-semibold mb-[10px]">
            Contributed pages · {concepts.length}
          </h2>

          {/* Concepts list or empty */}
          {conceptsLoading ? (
            <div className="card py-[6px] px-5">
              <ConceptRowSkeletonComponent />
              <ConceptRowSkeletonComponent />
            </div>
          ) : concepts.length > 0 ? (
            <div className="card">
              {concepts.map((c) => (
                <ConceptRow key={c.uuid} concept={c} />
              ))}
            </div>
          ) : (
            <div className="card">
              <EmptyState
                icon={Info}
                title="No contributions yet"
                description="This member hasn't contributed to any verified knowledge pages yet. Only webhook-verified contributions appear here."
              />
            </div>
          )}

          {/* Attribution footnote */}
          <p className="text-[12px] text-text-3 mt-[10px] max-w-[640px]">
            <Info className="w-[12px] h-[12px] inline-block mr-1 -mt-px" />
            Only webhook-verified contributions appear here. Writes this person
            made through CLI or MCP (self-reported identity) are not listed.
          </p>
        </>
      )}
    </div>
  );
}

/** Duplicate skeleton row for loading state. */
function ConceptRowSkeletonComponent() {
  return (
    <div className="flex gap-[14px] py-[15px] border-b border-border last:border-b-0">
      <div className="flex-1 min-w-0">
        <Skeleton className="h-4 w-[52%] mt-0.5" />
        <Skeleton className="h-[11px] w-[38%] mt-[10px]" />
      </div>
      <div className="flex-none">
        <Skeleton className="h-[13px] w-[44px]" />
      </div>
    </div>
  );
}
