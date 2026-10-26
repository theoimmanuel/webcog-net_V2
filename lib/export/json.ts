/**
 * JSON serializer for a {@link StudySession} (Req 14.3).
 *
 * The JSON is produced from the same flattened {@link ExportRow} set as the CSV
 * export (see `lib/export/records.ts`), so the two outputs always carry the same
 * number of records and identical field values (Req 14.6, Property 39). Parsing
 * the JSON reproduces exactly the collected records (Property 38).
 *
 * An empty session serializes to an empty JSON array; callers consult the
 * `noRecords` flag from {@link flattenSession} to surface a "no records were
 * available" indication (Req 14.7). Only derived numeric measures appear; there
 * is no field for raw imagery because none is ever stored (Req 14.4, Property 40).
 */

import type { StudySession } from "@/lib/harness/session";
import {
  flattenSession,
  type ExportDataset,
  type ExportRow,
} from "@/lib/export/records";

/**
 * Serialize a study session to a JSON array of flat export rows.
 *
 * Records appear in the assigned scenario order. An empty session yields `"[]"`.
 * The output is pretty-printed with two-space indentation for researcher
 * readability; `JSON.parse` of the result reproduces the export rows unchanged.
 */
export function toJson(session: StudySession): string {
  const dataset: ExportDataset = flattenSession(session);
  const rows: ExportRow[] = dataset.rows;
  return JSON.stringify(rows, null, 2);
}

/**
 * Whether the session has no collected records, so callers can present the
 * "no records were available" indication alongside the empty JSON array
 * (Req 14.7). Derived from the same flattening used by {@link toJson}.
 */
export function hasNoRecords(session: StudySession): boolean {
  return flattenSession(session).noRecords;
}
