// Feature: webcog-net-site
//
// Sustained-high cognitive-load detector (Req 8.4).
//
// A small, pure state machine that answers one question: has the HIGH
// Cognitive_Load_State persisted *continuously* for at least `SUSTAIN_MS`
// (3000 ms)? Scenario C only applies the Adaptive_Intervention once that
// continuous run exists (Property 18: fire iff a continuous HIGH run >= 3s
// exists, and never before the run reaches 3 s).
//
// The detector tracks `highSince` — the timestamp at which the *current*
// continuous run of HIGH began. Any non-HIGH sample breaks the run and resets
// `highSince` to null. A sustained run is detected when the elapsed time since
// `highSince` reaches `SUSTAIN_MS`.
//
// This module is intentionally DOM-free and clock-free: callers feed it
// `(state, timestamp)` pairs, so it is deterministic and directly unit- and
// property-testable. The Intervention Engine owns the DOM; this detector owns
// only the "is the threshold met?" logic.

import type { CognitiveLoadState } from "@/lib/load/source";

/**
 * The minimum continuous duration, in milliseconds, that the HIGH state must
 * persist before it counts as Sustained_High_Load (Req 8.4). The HIGH run must
 * last at least this long; a run shorter than this never fires (Property 18).
 */
export const SUSTAIN_MS = 3000;

/**
 * A pure detector for Sustained_High_Load. Fed one `(state, timestamp)` sample
 * at a time via {@link onSample}/{@link update}; reports whether a continuous
 * HIGH run has reached {@link SUSTAIN_MS} via {@link isSustained}.
 *
 * The timestamps supplied by the caller are expected to be monotonically
 * non-decreasing (as `performance.now()` / `LoadSample.timestamp` are). The
 * detector only ever measures `now - highSince`, so even out-of-order input
 * cannot make it fire before a genuine >= `SUSTAIN_MS` run has elapsed.
 */
export class SustainedHighDetector {
  /** Minimum continuous HIGH duration required to count as sustained. */
  private readonly sustainMs: number;

  /**
   * Timestamp when the current continuous run of HIGH began, or null when the
   * most recent sample was not HIGH (i.e. there is no active run).
   */
  private highSince: number | null = null;

  /** The timestamp of the most recently observed sample, or null before any. */
  private lastTimestamp: number | null = null;

  constructor(sustainMs: number = SUSTAIN_MS) {
    this.sustainMs = sustainMs;
  }

  /**
   * Feed one observation into the detector.
   *
   * - A HIGH sample starts a run if none is active (records `highSince`), or
   *   extends the current run (leaves `highSince` untouched).
   * - Any non-HIGH sample breaks the run and resets `highSince` to null.
   *
   * Returns the detector's current {@link isSustained} verdict after applying
   * this sample, as a convenience for callers that act on each sample.
   */
  update(state: CognitiveLoadState, timestamp: number): boolean {
    this.lastTimestamp = timestamp;
    if (state === "HIGH") {
      if (this.highSince === null) {
        this.highSince = timestamp;
      }
    } else {
      // Any non-HIGH sample breaks the continuous run (Req 8.4).
      this.highSince = null;
    }
    return this.isSustained();
  }

  /**
   * Convenience overload that takes a `{ state, timestamp }` shape — e.g. a
   * {@link import("@/lib/load/source").LoadSample}. Equivalent to
   * `update(sample.state, sample.timestamp)`.
   */
  onSample(sample: { state: CognitiveLoadState; timestamp: number }): boolean {
    return this.update(sample.state, sample.timestamp);
  }

  /**
   * Whether a continuous HIGH run has lasted at least `sustainMs` as of the most
   * recently observed timestamp (Property 18). False whenever no HIGH run is
   * active, or an active run has not yet reached the threshold.
   */
  isSustained(): boolean {
    if (this.highSince === null || this.lastTimestamp === null) {
      return false;
    }
    return this.lastTimestamp - this.highSince >= this.sustainMs;
  }

  /**
   * The timestamp when the current continuous HIGH run began, or null when no
   * run is active. Exposed for inspection/tests and HUD diagnostics.
   */
  getHighSince(): number | null {
    return this.highSince;
  }

  /** Clear all state, as if no samples had ever been observed. */
  reset(): void {
    this.highSince = null;
    this.lastTimestamp = null;
  }
}

/** Create a {@link SustainedHighDetector}. */
export function createSustainedHighDetector(
  sustainMs: number = SUSTAIN_MS,
): SustainedHighDetector {
  return new SustainedHighDetector(sustainMs);
}
