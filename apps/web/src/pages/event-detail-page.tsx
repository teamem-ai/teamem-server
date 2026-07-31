import { useState, useEffect, useCallback } from "react";
import { useParams, Link } from "react-router-dom";
import { ArrowLeft, AlertTriangle, FileJson, Clock, User, Server } from "lucide-react";
import { Skeleton } from "@/components/ui/skeleton";
import { NotFound } from "@/components/ui/not-found";
import { fetchEvent, ApiError } from "@/lib/api";
import { useScope } from "@/lib/scope";
import { formatFull } from "@/lib/date";
import type { EventDetail } from "@teamem/schema";

/**
 * Event detail page — renders the audited payload for an MCP write or any
 * other ingested event. Requires the read:payload scope; without it we show
 * an honest permission-denied state instead of fabricating or 404-ing.
 */
export function EventDetailPage() {
  const { id } = useParams<{ id: string }>();
  const scope = useScope();
  const [event, setEvent] = useState<EventDetail | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [notFound, setNotFound] = useState(false);

  const load = useCallback(async () => {
    if (!id || !scope.projectId) return;
    try {
      setLoading(true);
      setError(null);
      setNotFound(false);
      const data = await fetchEvent(id, scope.projectId);
      setEvent(data);
    } catch (err) {
      if (err instanceof ApiError && err.status === 404) {
        setNotFound(true);
      } else if (err instanceof ApiError && err.status === 403) {
        setError(
          "This portal session does not have permission to read raw event payloads. Ask a team admin for the read:payload scope.",
        );
      } else if (err instanceof ApiError && err.status === 401) {
        setError(
          "This portal session cannot read events yet — the data-plane API requires an API key, and web-session read access is not available on this server.",
        );
      } else if (err instanceof ApiError) {
        setError(err.message);
      } else {
        setError("Failed to load event");
      }
    } finally {
      setLoading(false);
    }
  }, [id, scope.projectId]);

  useEffect(() => {
    if (scope.status === "ready") {
      load();
    }
  }, [scope.status, load]);

  if (scope.status === "loading" || loading) {
    return <EventDetailSkeleton />;
  }

  if (scope.status === "signed-out") {
    return (
      <div className="card">
        <div className="empty-state py-16">
          <div className="e-icon">
            <AlertTriangle />
          </div>
          <h3>Sign in required</h3>
          <p>You need to sign in with GitHub to view this event.</p>
          <div className="e-actions">
            <a className="btn btn-primary" href="/auth/github">
              Sign in with GitHub
            </a>
          </div>
        </div>
      </div>
    );
  }

  if (notFound) {
    return <NotFound />;
  }

  if (error || !event) {
    return (
      <div>
        <Link to="/events" className="btn btn-ghost btn-sm mb-4 inline-flex items-center gap-1.5">
          <ArrowLeft className="w-4 h-4" /> Events
        </Link>
        <div className="banner error mb-4">
          <AlertTriangle className="w-4 h-4" />
          <div>{error ?? "Event not found"}</div>
          <div className="b-actions">
            <button className="btn btn-sm btn-outline" onClick={load}>
              Retry
            </button>
          </div>
        </div>
      </div>
    );
  }

  const actor = event.actor;
  const source = event.source;

  return (
    <div className="content wide">
      <Link
        to="/events"
        className="btn btn-ghost btn-sm inline-flex items-center gap-1.5 mb-[14px]"
      >
        <ArrowLeft className="w-4 h-4" /> Events
      </Link>

      <div className="c-head">
        <div className="c-badges">
          <span className="badge">{source.kind}</span>
          <span className="badge muted">{source.channel}</span>
        </div>
        <h1 className="c-title">Event {event.id}</h1>
        <div className="c-meta">
          <span className="copy-chip">
            <Server className="w-3 h-3" />
            {source.deliveryId}
          </span>
          <span title={formatFull(event.occurredAt)}>
            <Clock className="w-3 h-3 inline mr-1" />
            Occurred {formatFull(event.occurredAt)}
          </span>
          <span title={formatFull(event.createdAt)}>
            Ingested {formatFull(event.createdAt)}
          </span>
        </div>
      </div>

      <div className="concept-grid">
        <div className="card">
          <div className="card-body" style={{ padding: "26px 30px" }}>
            <h3 className="text-base font-semibold mb-3 flex items-center gap-2">
              <FileJson className="w-4 h-4" /> Redacted payload
            </h3>
            <pre className="code-block">
              <code>{JSON.stringify(event.payload, null, 2)}</code>
            </pre>
          </div>
        </div>

        <div className="rail">
          <div className="card">
            <div className="card-body" style={{ padding: "16px" }}>
              <h4 style={{ margin: "0 0 12px 0", fontSize: "14px" }}>Actor</h4>
              {actor ? (
                <div className="flex items-center gap-2">
                  <User className="w-4 h-4 text-muted-foreground" />
                  <div>
                    <div className="font-medium">
                      {actor.displayLogin ?? actor.providerUserId ?? "Unknown"}
                    </div>
                    <div className="small muted">{event.actorProvenance}</div>
                  </div>
                </div>
              ) : (
                <div className="small muted">No actor recorded</div>
              )}
            </div>
          </div>

          <div className="card">
            <div className="card-body" style={{ padding: "16px" }}>
              <h4 style={{ margin: "0 0 12px 0", fontSize: "14px" }}>Ingested by</h4>
              <div className="small muted">
                {event.ingestedBy.credentialId && (
                  <div>credential: {event.ingestedBy.credentialId}</div>
                )}
                {event.ingestedBy.principalId && (
                  <div>principal: {event.ingestedBy.principalId}</div>
                )}
                {!event.ingestedBy.credentialId && !event.ingestedBy.principalId && (
                  <div>System ingestion</div>
                )}
              </div>
            </div>
          </div>
        </div>
      </div>
    </div>
  );
}

function EventDetailSkeleton() {
  return (
    <div className="content wide">
      <Skeleton className="h-5 w-24 mb-[14px]" />
      <div className="c-head">
        <Skeleton className="h-[22px] w-[180px]" />
        <Skeleton className="h-[30px] w-[64%]" />
        <Skeleton className="h-[20px] w-[46%]" />
      </div>
      <div className="concept-grid">
        <div className="card">
          <div className="card-body" style={{ padding: "26px 30px" }}>
            <Skeleton className="h-[200px] w-full" />
          </div>
        </div>
      </div>
    </div>
  );
}
