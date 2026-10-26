/**
 * Flatten a {@link StudySession} into the ordered, flat export rows shared by
 * both serializers (`lib/export/csv.ts` and `lib/export/json.ts`).
 *
 * Producing one canonical row set and feeding it to both serializers is what
 * guarantees the CSV and JSON exports contain the same number of records and
 * identical field values for each corresponding record (Req 14.6, Property 39),
 * and that the JSON export round-trips the collected records (Property 38).
 *
 * Every row carries session-level context — the participant/session ids, the
 * assigned scenario order, and the ISO 8601 consent timestamp — so that each
 * exported record is self-describing and every export includes the order and
 * consent timestamp (Req 14.5, Property 40).
 *
 * Only derived numeric measures are present. There is no field for raw video or
 * biometric imagery because the store never holds any (Req 14.4, Property 40);
 * excluding imagery is therefore structural, not a filtering step.
 */

import type {
  LatencyStats,
  NasaTlxScores,
  ScenarioId,
  ScenarioOrder,
  StudyRecord,
  StudySession,
} from "@/lib/harness/session";
import { MODEL_SIZE_LIMIT_BYTES } from "@/lib/harness/session";

/** Bytes per megabyte (binary MiB) used to derive `modelSizeMb` (Req 14.1). */
export const BYTES_PER_MB = 1_048_576;

/**
 * One flattened study record as it appears in an export. All fields are scalar
 * (string, number, boolean) or `null`, which keeps CSV and JSON representable
 * from a single structure.
 */
export interface ExportRow {
  participantId: string;
  sessionId: string;
  scenario: ScenarioId;
  /** Assigned order joined for self-description, e.g. "A-B-C" (Req 14.5). */
  scenarioOrder: string;
  /** ISO 8601 UTC consent timestamp for the session (Req 14.5). */
  consentTimestamp: string | null;
  status: StudyRecord["status"];
  taskCompletionTimeMs: number | null;
  mental: number | null;
  physical: number | null;
  temporal: number | null;
  performance: number | null;
  effort: number | null;
  frustration: number | null;
  latencyMeanMs: number | null;
  latencyMaxMs: number | null;
  latencyP95Ms: number | null;
  latencyExceeds: boolean | null;
  modelSizeBytes: number;
  /** Model artifact size in megabytes (Req 14.1). */
  modelSizeMb: number;
  interventionApplied: boolean;
}

/**
 * The ordered export column keys. The serializers and header rows derive from
 * this single list so column order and the field set stay in lock-step across
 * CSV and JSON (Req 14.6, 14.7).
 */
export const EXPORT_COLUMNS: readonly (keyof ExportRow)[] = [
  "participantId",
  "sessionId",
  "scenario",
  "scenarioOrder",
  "consentTimestamp",
  "status",
  "taskCompletionTimeMs",
  "mental",
  "physical",
  "temporal",
  "performance",
  "effort",
  "frustration",
  "latencyMeanMs",
  "latencyMaxMs",
  "latencyP95Ms",
  "latencyExceeds",
  "modelSizeBytes",
  "modelSizeMb",
  "interventionApplied",
] as const;

/** The result of flattening a session: ordered rows plus an empty-data flag. */
export interface ExportDataset {
  rows: ExportRow[];
  /**
   * True when the session has collected no study records. Serializers still
   * emit headers (CSV) or an empty array (JSON); callers surface a "no records
   * were available" indication to the researcher (Req 14.7).
   */
  noRecords: boolean;
}

/** Convert a model size in bytes to megabytes (Req 14.1). */
export function bytesToMb(bytes: number): number {
  return bytes / BYTES_PER_MB;
}

/**
 * Pull the six NASA-TLX dimensions out of a record, defaulting to null when the
 * questionnaire was not completed for that scenario.
 */
function tlxFields(tlx: NasaTlxScores | null) {
  return {
    mental: tlx ? tlx.mental : null,
    physical: tlx ? tlx.physical : null,
    temporal: tlx ? tlx.temporal : null,
    performance: tlx ? tlx.performance : null,
    effort: tlx ? tlx.effort : null,
    frustration: tlx ? tlx.frustration : null,
  };
}

/**
 * Pull the latency statistics out of a record, defaulting to null when no
 * inference latency was recorded for that scenario.
 */
function latencyFields(latency: LatencyStats | null) {
  return {
    latencyMeanMs: latency ? latency.meanMs : null,
    latencyMaxMs: latency ? latency.maxMs : null,
    latencyP95Ms: latency ? latency.p95Ms : null,
    latencyExceeds: latency ? latency.exceedsTarget : null,
  };
}

/**
 * Return the scenarios in the order they should be exported. When an order was
 * assigned, records are emitted in that order (Req 14.5); otherwise any records
 * present are emitted in a stable A, B, C order so output is deterministic.
 */
function orderedScenarios(session: StudySession): ScenarioId[] {
  if (session.scenarioOrder) {
    return [...session.scenarioOrder];
  }
  const stable: ScenarioId[] = ["A", "B", "C"];
  return stable.filter((id) => hasRecordFor(session, id));
}

function hasRecordFor(session: StudySession, scenario: ScenarioId): boolean {
  return Object.prototype.hasOwnProperty.call(session.records, scenario);
}

function formatScenarioOrder(order: ScenarioOrder | null): string {
  return order ? order.join("-") : "";
}

/**
 * Build one flat export row from a session and one of its study records.
 */
function toRow(session: StudySession, record: StudyRecord): ExportRow {
  return {
    participantId: session.participantId,
    sessionId: session.sessionId,
    scenario: record.scenario,
    scenarioOrder: formatScenarioOrder(session.scenarioOrder),
    consentTimestamp: session.consentTimestamp,
    status: record.status,
    taskCompletionTimeMs: record.taskCompletionTimeMs,
    ...tlxFields(record.tlx),
    ...latencyFields(record.latency),
    modelSizeBytes: session.modelSizeBytes,
    modelSizeMb: bytesToMb(session.modelSizeBytes),
    interventionApplied: record.interventionApplied,
  };
}

/**
 * Flatten a {@link StudySession} into the shared ordered export dataset.
 *
 * Records are emitted in the assigned scenario order (falling back to a stable
 * A/B/C order when none is assigned). The returned `noRecords` flag is true when
 * the session has collected nothing, so serializers still emit headers / an
 * empty array and callers can surface the "no records" indication (Req 14.7).
 */
export function flattenSession(session: StudySession): ExportDataset {
  const rows: ExportRow[] = [];
  for (const scenario of orderedScenarios(session)) {
    const record = session.records[scenario];
    if (record) {
      rows.push(toRow(session, record));
    }
  }
  return { rows, noRecords: rows.length === 0 };
}

/** Whether the model artifact size for the session is at/over the limit (Req 4.6). */
export function modelSizeExceeds(session: StudySession): boolean {
  return session.modelSizeBytes >= MODEL_SIZE_LIMIT_BYTES;
}
