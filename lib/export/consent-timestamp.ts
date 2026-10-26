/**
 * ISO 8601 UTC consent-timestamp helpers.
 *
 * Shared by the consent flow (which stamps the moment consent is granted,
 * Req 2.4) and by the export serializers (which must include that timestamp in
 * every export in ISO 8601 format, Req 14.5).
 *
 * The canonical format produced here is the UTC instant with millisecond
 * precision and a trailing `Z`, e.g. `2026-06-19T12:34:56.789Z`. This is exactly
 * what `Date.prototype.toISOString()` yields, which keeps producer and validator
 * perfectly aligned and guarantees Property 4: the stored timestamp parses as a
 * valid ISO 8601 UTC instant and round-trips to the same instant.
 */

/**
 * A UTC ISO 8601 instant: `YYYY-MM-DDTHH:mm:ss(.sss)?Z`.
 *
 * Fractional seconds are optional (0, 3, 6, or 9 digits are accepted). The zone
 * designator must be the literal `Z` so the instant is unambiguously UTC.
 */
const ISO_8601_UTC_PATTERN =
  /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{1,9})?Z$/;

/**
 * Produce an ISO 8601 UTC timestamp for the current moment.
 *
 * This is the value recorded when a participant grants consent (Req 2.4) and
 * surfaced unchanged in every export (Req 14.5). Accepts an optional `Date` so
 * callers and tests can stamp a specific instant deterministically.
 */
export function nowConsentTimestamp(at: Date = new Date()): string {
  return at.toISOString();
}

/**
 * Return true when `value` is a well-formed ISO 8601 UTC instant that both
 * matches the canonical shape and round-trips to the same instant.
 *
 * The round-trip check parses the string to an instant, re-serializes that
 * instant with `toISOString()`, and confirms the result denotes the same point
 * in time as the input. This rejects strings that are syntactically plausible
 * but not real instants, such as `2026-13-40T99:99:99Z` (which `Date.parse`
 * turns into `NaN`) or `2026-02-30T00:00:00Z` (an impossible calendar date that
 * normalizes to a different instant on re-serialization).
 */
export function isValidConsentTimestamp(value: unknown): value is string {
  if (typeof value !== "string") return false;
  if (!ISO_8601_UTC_PATTERN.test(value)) return false;
  const parsedMs = Date.parse(value);
  if (Number.isNaN(parsedMs)) return false;
  // Round-trip against the canonical serialization. `Date.parse` silently rolls
  // over impossible calendar values (e.g. Feb 30 -> Mar 2), so a millisecond
  // comparison alone cannot catch them. Comparing the input's canonical form to
  // the re-serialized instant does: a rolled-over date changes the string.
  return canonicalize(value) === new Date(parsedMs).toISOString();
}

/**
 * Rewrite a pattern-matched ISO 8601 UTC string into the canonical form that
 * `Date.prototype.toISOString()` emits: always three fractional-second digits.
 * This lets {@link isValidConsentTimestamp} compare the caller's literal date
 * and time components against the normalized instant without being tripped up by
 * a differing number of fractional digits (e.g. `.7` vs `.700`).
 */
function canonicalize(value: string): string {
  const [datePart, timePartWithZone] = value.split("T");
  const timePart = timePartWithZone.slice(0, -1); // drop trailing "Z"
  const [hms, frac = ""] = timePart.split(".");
  const millis = (frac + "000").slice(0, 3);
  return `${datePart}T${hms}.${millis}Z`;
}
