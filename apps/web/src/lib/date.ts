/**
 * Date formatting utilities for the teamem portal.
 * Times use UTC ISO 8601 with millisecond precision.
 * UI shows relative time with absolute UTC on hover.
 */

const MINUTE = 60;
const HOUR = 60 * MINUTE;
const DAY = 24 * HOUR;
const WEEK = 7 * DAY;

/** Format an ISO datetime string to a relative time string.
 *  e.g. "2h ago", "3d ago", "just now" */
export function relativeTime(iso: string): string {
  const now = Date.now();
  const then = new Date(iso).getTime();
  const diff = (now - then) / 1000; // seconds

  if (diff < 60) return "just now";
  if (diff < HOUR) {
    const m = Math.floor(diff / MINUTE);
    return `${m}m ago`;
  }
  if (diff < DAY) {
    const h = Math.floor(diff / HOUR);
    return `${h}h ago`;
  }
  if (diff < WEEK) {
    const d = Math.floor(diff / DAY);
    return `${d}d ago`;
  }
  if (diff < 30 * DAY) {
    const w = Math.floor(diff / WEEK);
    return `${w}w ago`;
  }
  return formatDate(iso);
}

/** Format an ISO datetime to a short date string.
 *  e.g. "Jul 28, 2026" */
export function formatDate(iso: string): string {
  const d = new Date(iso);
  return d.toLocaleDateString("en-US", {
    month: "short",
    day: "numeric",
    year: "numeric",
  });
}

/** Format an ISO datetime to a full UTC string for tooltips.
 *  e.g. "Jul 28, 2026 · 04:02 UTC" */
export function formatFull(iso: string): string {
  const d = new Date(iso);
  const date = d.toLocaleDateString("en-US", {
    month: "short",
    day: "numeric",
    year: "numeric",
  });
  const time = d.toLocaleTimeString("en-US", {
    hour: "2-digit",
    minute: "2-digit",
    hour12: false,
    timeZone: "UTC",
  });
  return `${date} · ${time} UTC`;
}
