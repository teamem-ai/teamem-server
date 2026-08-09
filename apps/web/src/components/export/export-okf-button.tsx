/**
 * OKF export entry — M3-EXPORT-05.
 *
 * Two moving parts, both thin:
 *
 *   1. `useExportOkf(projectId)` — the state machine for one download: it
 *      calls `GET /v1/export` through the shared API client, hands the
 *      returned .tar.gz to the browser as a real download (object-URL +
 *      anchor click), and reports the outcome as visible feedback.
 *
 *   2. `ExportOkfButton` — the presentational header action. The host page
 *      decides whether it is rendered (role-aware: member+, real project
 *      present — the server enforces the same gate); the button only
 *      forwards busy/onDownload.
 *
 * Red lines honored:
 *   - No fake success: the success message repeats the filename the SERVER
 *     sent in Content-Disposition; nothing is invented client-side.
 *   - No silent failure: every non-2xx becomes a visible error banner. The
 *     fail-closed export.download audit lock (N7) is explained in plain
 *     language instead of surfacing a raw envelope.
 *   - Honest empty state: with no project selected there is nothing to
 *     export — the caller does not render the button (the page shows its
 *     own "No project yet" state), and the hook guards the call anyway.
 */
import { useCallback, useState } from "react";
import { Download, Loader2 } from "lucide-react";
import {
  ApiError,
  AuditWriteFailedError,
  downloadExportFile,
} from "@/lib/api";

// ── Feedback contract ───────────────────────────────────────────────────────

export type ExportFeedback =
  | { variant: "success"; message: string }
  | { variant: "error"; message: string };

// ── Download mechanics ──────────────────────────────────────────────────────

/**
 * Push a Blob to the browser as a file download: object URL + hidden anchor
 * with the server-provided filename, then clean up. Standard approach for
 * binary responses fetched over XHR/fetch.
 */
function triggerBrowserDownload(blob: Blob, filename: string) {
  const url = URL.createObjectURL(blob);
  const anchor = document.createElement("a");
  anchor.href = url;
  anchor.download = filename;
  anchor.style.display = "none";
  document.body.appendChild(anchor);
  anchor.click();
  anchor.remove();
  URL.revokeObjectURL(url);
}

// ── Hook: one export attempt's lifecycle ────────────────────────────────────

export function useExportOkf(projectId: string | null) {
  const [busy, setBusy] = useState(false);
  const [feedback, setFeedback] = useState<ExportFeedback | null>(null);

  const download = useCallback(async () => {
    if (!projectId) {
      // Defensive: the caller never renders the button without a project.
      setFeedback({
        variant: "error",
        message:
          "Nothing to export yet — your team has no project with compiled knowledge.",
      });
      return;
    }

    setBusy(true);
    setFeedback(null);
    try {
      const { filename, blob } = await downloadExportFile(projectId);
      triggerBrowserDownload(blob, filename);
      setFeedback({ variant: "success", message: `Downloaded ${filename}` });
    } catch (err) {
      let message: string;
      if (err instanceof AuditWriteFailedError) {
        message =
          "The download was blocked because the server could not record it in the audit log (fail-closed). Please try again.";
      } else if (err instanceof ApiError) {
        // The server's own envelope message — surface the real reason.
        message = err.message;
      } else {
        message = "Export failed — the download did not complete.";
      }
      setFeedback({ variant: "error", message });
    } finally {
      setBusy(false);
    }
  }, [projectId]);

  return { busy, feedback, download };
}

// ── Button ──────────────────────────────────────────────────────────────────

export function ExportOkfButton({
  busy,
  onDownload,
}: {
  busy: boolean;
  onDownload: () => void;
}) {
  return (
    <button
      type="button"
      className="btn btn-outline btn-sm"
      onClick={onDownload}
      disabled={busy}
      title="Download this project's compiled knowledge as a portable OKF Markdown archive (.tar.gz) — member+"
    >
      {busy ? (
        <Loader2 className="w-4 h-4 animate-spin" />
      ) : (
        <Download className="w-4 h-4" />
      )}
      {busy ? "Preparing bundle…" : "Export OKF bundle"}
    </button>
  );
}