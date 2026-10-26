"use client";

/**
 * `/study/export` — the Researcher data-export route (Req 14).
 *
 * This route renders {@link ExportScreen}, which owns the CSV/JSON download
 * actions, the empty-data "no records" state (Req 14.7), and the export-failure
 * alert (Req 14.8). The route component itself takes no props so it conforms to
 * Next.js's `PageProps` constraint.
 *
 * INTEGRATION SEAM (task 21.1): the live {@link StudySession} is owned by the
 * StudyProvider / SessionStore the harness creates. Until that provider exists,
 * {@link ExportScreen} recovers the session from the `sessionStorage` mirror
 * (reload path) or falls back to an empty session. When task 21.1 lands, read
 * the live session from the provider here (e.g. `useStudySession()`) and pass it
 * to {@link ExportScreen} via the `session` prop so the serializers run against
 * in-memory data rather than the storage mirror.
 */

import ExportScreen from "@/app/components/export/ExportScreen";

export default function StudyExportPage() {
  // SEAM (task 21.1): once the StudyProvider exists, pass its live session:
  //   const session = useStudySession();
  //   return <ExportScreen session={session} />;
  return <ExportScreen />;
}
