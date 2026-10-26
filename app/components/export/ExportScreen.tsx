"use client";

/**
 * ExportScreen — the Researcher data-export UI (Req 14).
 *
 * Rendered by `app/study/export/page.tsx`. This component exposes exactly two
 * actions, "Export CSV" and "Export JSON", that serialize the collected
 * {@link StudySession} and trigger a file download in the browser (Req 14.2,
 * 14.3). Export is strictly read-only: it never mutates the session, so a failed
 * export leaves the collected study data unchanged (Req 14.8).
 *
 * Empty-data handling (Req 14.7): when the session holds no records the
 * serializers still produce a headers-only CSV / an empty JSON array, so both
 * downloads remain available; alongside them the component surfaces a visible
 * `role="status"` "no records were available" note.
 *
 * Failure handling (Req 14.8): the Blob/object-URL/anchor download is wrapped in
 * a try/catch. On any error the session is untouched (export is read-only) and a
 * visible `role="alert"` message reports that the export did not complete.
 *
 * INTEGRATION SEAM (task 21.1): the live {@link StudySession} is owned by the
 * StudyProvider / SessionStore created in the harness. That provider does not
 * exist yet, so this component resolves a session defensively:
 *
 *   1. If a provider supplies a session via the `session` prop, use it (the
 *      harness renders this component inside the provider and passes the live
 *      session from `SessionStore.getSession()`).
 *   2. Otherwise rehydrate the session the SessionStore mirrored into
 *      `sessionStorage` for this tab, so an export still works after a reload.
 *   3. Otherwise fall back to an empty, consent-pending session so the page
 *      renders the no-records state and the two exports still emit
 *      headers-only / empty output.
 *
 * When task 21.1 lands, the provider passes its live `StudySession` into
 * {@link ExportScreen} as the `session` prop; the `sessionStorage` rehydration
 * below then only serves the reload-recovery path. Keeping the prop seam on this
 * component (not on the route `page.tsx`) satisfies Next.js's `PageProps`
 * constraint, which forbids custom props on a route's default export.
 */

import { useEffect, useMemo, useState } from "react";
import { toCsv } from "@/lib/export/csv";
import { toJson, hasNoRecords } from "@/lib/export/json";
import type { StudySession } from "@/lib/harness/session";

/**
 * The `sessionStorage` key the {@link SessionStore} mirrors the live session
 * into. Kept in sync with `lib/harness/session.ts` so this component can recover
 * the session after a reload before the StudyProvider (task 21.1) exists.
 */
const STORAGE_KEY = "webcog-net:study-session";

/** An empty, consent-pending session used when nothing can be recovered. */
function createEmptySession(): StudySession {
  return {
    participantId: "",
    sessionId: "",
    consentTimestamp: null,
    consentGranted: false,
    scenarioOrder: null,
    records: {} as StudySession["records"],
    modelSizeBytes: 0,
    modelSizeExceeds: false,
  };
}

/**
 * Minimal structural check mirroring `SessionStore`'s validation, so corrupt or
 * foreign `sessionStorage` data does not become a bogus session.
 */
function looksLikeSession(value: unknown): value is StudySession {
  if (typeof value !== "object" || value === null) return false;
  const v = value as Record<string, unknown>;
  return (
    typeof v.participantId === "string" &&
    typeof v.sessionId === "string" &&
    (v.consentTimestamp === null || typeof v.consentTimestamp === "string") &&
    typeof v.records === "object" &&
    v.records !== null &&
    typeof v.modelSizeBytes === "number"
  );
}

/**
 * Rehydrate the mirrored session from `sessionStorage`, or null when it is
 * unavailable (SSR, disabled storage), empty, or corrupt. Browser-only: guarded
 * so it is never called during server rendering.
 */
function rehydrateSession(): StudySession | null {
  if (typeof window === "undefined") return null;
  try {
    const raw = window.sessionStorage.getItem(STORAGE_KEY);
    if (!raw) return null;
    const parsed: unknown = JSON.parse(raw);
    return looksLikeSession(parsed) ? parsed : null;
  } catch {
    return null;
  }
}

/** The two export formats and the MIME type / extension each uses. */
type ExportFormat = "csv" | "json";

const FORMAT_META: Record<
  ExportFormat,
  { label: string; mimeType: string; extension: string }
> = {
  csv: { label: "Export CSV", mimeType: "text/csv", extension: "csv" },
  json: { label: "Export JSON", mimeType: "application/json", extension: "json" },
};

/**
 * Build a download filename for a session and format, e.g.
 * `webcog-net-<sessionId>.csv`. Falls back to a generic name when no session id
 * is known (empty-session / recovery path).
 */
function downloadFilename(session: StudySession, format: ExportFormat): string {
  const id = session.sessionId.trim() || "session";
  return `webcog-net-${id}.${FORMAT_META[format].extension}`;
}

/**
 * Trigger a client-side file download for the given text. Wraps the content in a
 * {@link Blob}, creates an object URL, clicks a temporary anchor, then revokes
 * the URL. Browser-only — call from an event handler, never during SSR. Throws
 * if the browser APIs are unavailable so the caller can surface a failure
 * without mutating any study data (Req 14.8).
 */
function triggerDownload(
  content: string,
  mimeType: string,
  filename: string,
): void {
  if (typeof window === "undefined" || typeof document === "undefined") {
    throw new Error("Downloads are only available in the browser.");
  }
  const blob = new Blob([content], { type: mimeType });
  const url = URL.createObjectURL(blob);
  try {
    const anchor = document.createElement("a");
    anchor.href = url;
    anchor.download = filename;
    anchor.rel = "noopener";
    document.body.appendChild(anchor);
    anchor.click();
    anchor.remove();
  } finally {
    // Always release the object URL, even if the click throws.
    URL.revokeObjectURL(url);
  }
}

export interface ExportScreenProps {
  /**
   * The live study session, supplied by the StudyProvider (task 21.1). When
   * omitted the component recovers the session from `sessionStorage` (reload
   * path) or falls back to an empty session.
   */
  session?: StudySession;
}

export default function ExportScreen({ session: provided }: ExportScreenProps) {
  // Resolve the session once on mount. `sessionStorage` is browser-only, so the
  // first render (which can run on the server) uses the provided session or an
  // empty one; the effect then upgrades to the rehydrated session in the browser.
  const [session, setSession] = useState<StudySession>(
    () => provided ?? createEmptySession(),
  );
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    if (provided) {
      setSession(provided);
      return;
    }
    const recovered = rehydrateSession();
    if (recovered) setSession(recovered);
  }, [provided]);

  const noRecords = useMemo(() => hasNoRecords(session), [session]);

  function handleExport(format: ExportFormat) {
    // Export is read-only; nothing here mutates `session`, so a failure leaves
    // the collected study data unchanged (Req 14.8).
    try {
      const content = format === "csv" ? toCsv(session) : toJson(session);
      triggerDownload(
        content,
        FORMAT_META[format].mimeType,
        downloadFilename(session, format),
      );
      setError(null);
    } catch {
      setError(
        `The ${FORMAT_META[format].label} did not complete. Your collected study data is unchanged — you can try the export again.`,
      );
    }
  }

  return (
    <main className="mx-auto flex min-h-screen max-w-3xl flex-col justify-center gap-8 px-6 py-16">
      <section
        aria-labelledby="export-heading"
        className="flex flex-col gap-8 rounded-xl border border-neutral-800 bg-neutral-950/60 p-8 shadow-lg"
      >
        <header className="flex flex-col gap-3">
          <p className="text-sm font-medium uppercase tracking-widest text-neutral-400">
            Study data
          </p>
          <h1 id="export-heading" className="text-3xl font-semibold sm:text-4xl">
            Export collected data
          </h1>
          <p className="text-neutral-300">
            Download every collected measure — task completion time, the six
            NASA-TLX scores, inference latency, and model size — as CSV or JSON.
            Exports include the assigned scenario order and the consent
            timestamp, and never contain raw video or biometric imagery.
          </p>
        </header>

        {noRecords ? (
          <p
            role="status"
            aria-live="polite"
            className="rounded-lg border border-amber-900/60 bg-amber-950/30 p-4 text-amber-100/90"
          >
            No records were available. The export will contain only the field
            headers (CSV) or an empty list (JSON).
          </p>
        ) : null}

        {error ? (
          <p
            role="alert"
            className="rounded-lg border border-red-900/60 bg-red-950/40 p-4 text-red-100"
          >
            {error}
          </p>
        ) : null}

        <div className="flex flex-col gap-4 sm:flex-row sm:items-center">
          <button
            type="button"
            onClick={() => handleExport("csv")}
            aria-label="Export collected study data as a CSV file"
            className="inline-flex items-center justify-center rounded-md bg-neutral-100 px-5 py-3 text-sm font-semibold text-neutral-900 transition hover:bg-white focus:outline-none focus-visible:ring-2 focus-visible:ring-neutral-100 focus-visible:ring-offset-2 focus-visible:ring-offset-neutral-950"
          >
            {FORMAT_META.csv.label}
          </button>
          <button
            type="button"
            onClick={() => handleExport("json")}
            aria-label="Export collected study data as a JSON file"
            className="inline-flex items-center justify-center rounded-md border border-neutral-700 px-5 py-3 text-sm font-semibold text-neutral-200 transition hover:bg-neutral-800 focus:outline-none focus-visible:ring-2 focus-visible:ring-neutral-400 focus-visible:ring-offset-2 focus-visible:ring-offset-neutral-950"
          >
            {FORMAT_META.json.label}
          </button>
        </div>

        <p className="text-sm text-neutral-500">
          Exports are generated entirely in your browser from data held on this
          device. Nothing is uploaded.
        </p>
      </section>
    </main>
  );
}
