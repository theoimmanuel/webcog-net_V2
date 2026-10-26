/**
 * CSV serializer for a {@link StudySession} (Req 14.2).
 *
 * The CSV is produced from the same flattened {@link ExportRow} set as the JSON
 * export (see `lib/export/records.ts`), so the two outputs always carry the same
 * number of records and identical field values (Req 14.6, Property 39).
 *
 * The header row is always present, including when no records have been
 * collected — an empty session yields a headers-only file (Req 14.7). Only
 * derived numeric measures appear; there is no column for raw imagery because
 * none is ever stored (Req 14.4, Property 40).
 */

import type { StudySession } from "@/lib/harness/session";
import {
  EXPORT_COLUMNS,
  flattenSession,
  type ExportDataset,
  type ExportRow,
} from "@/lib/export/records";

/** Line terminator for CSV rows (CRLF per RFC 4180). */
const CRLF = "\r\n";

/**
 * Escape a single CSV field per RFC 4180.
 *
 * A field is quoted when it contains a comma, a double quote, or a line break;
 * embedded double quotes are doubled. `null` is rendered as an empty field so an
 * absent measure is distinguishable from an empty string only by context, which
 * matches how the JSON side encodes `null`.
 */
function escapeField(value: string | number | boolean | null): string {
  if (value === null) return "";
  const text = typeof value === "string" ? value : String(value);
  const mustQuote = /[",\r\n]/.test(text);
  if (!mustQuote) return text;
  return `"${text.replace(/"/g, '""')}"`;
}

/** Render one export row as a CSV line following {@link EXPORT_COLUMNS} order. */
function rowToLine(row: ExportRow): string {
  return EXPORT_COLUMNS.map((column) => escapeField(row[column])).join(",");
}

/** The CSV header line: the export column keys in canonical order. */
function headerLine(): string {
  return EXPORT_COLUMNS.map((column) => escapeField(column)).join(",");
}

/**
 * Serialize a study session to CSV text.
 *
 * The output always begins with the header line (Req 14.7). Each subsequent line
 * is one study record in the assigned scenario order. An empty session produces
 * the header line alone.
 */
export function toCsv(session: StudySession): string {
  const dataset: ExportDataset = flattenSession(session);
  const lines = [headerLine(), ...dataset.rows.map(rowToLine)];
  return lines.join(CRLF);
}
