// Feature: webcog-net-site
//
// Pure, DOM-free Feature_Aggregator for the Vision_Pipeline (Req 3.3, 3.5).
//
// Buffers per-frame features (produced by features.ts) and, on each 1-second
// tick, emits an AggregatedWindow summarising the trailing 5-second span:
//   - mean EAR over the window (unitless),
//   - blink rate in blinks/min derived from the blink events in the window,
//   - mean saccade velocity in deg/s.
//
// The window advances in exactly 1-second increments and always spans the
// trailing 5 seconds, so each window starts exactly 1 second after the previous
// one (design.md Property 7).
//
// Transient face loss (Req 3.5): when a window slot has no fresh/valid frames
// (because the pipeline detected no face), the aggregator reuses the previously
// emitted aggregated features for that slot and marks the result `degraded`, so
// the Classifier keeps receiving a well-formed window during a brief dropout.
//
// This module holds no DOM/webcam references; every operation is a pure
// function of the frames pushed into it, so it is trivially unit- and
// property-testable.

import type { FeatureFrame } from "@/lib/vision/features";

/** Default sliding-window span in milliseconds (trailing 5 seconds). */
export const WINDOW_MS = 5000;
/** Default window advance step in milliseconds (1 second). */
export const STEP_MS = 1000;

/**
 * Aggregated feature summary for one 5-second window slot. Matches the shape
 * declared in design.md and consumed by the Classifier.
 */
export interface AggregatedWindow {
  /** Mean EAR over the window, unitless and non-negative. */
  ear: number;
  /** Blink rate derived from blink events in the window, in blinks/min. */
  blinkRate: number;
  /** Mean saccade velocity over the window, in deg/s. */
  saccadeVelocity: number;
  /** Number of frames that contributed to this window. */
  frames: number;
  /** Inclusive start timestamp (ms) of the trailing 5-second span. */
  startT: number;
  /** Exclusive end timestamp (ms) of the trailing 5-second span. */
  endT: number;
  /**
   * True when this window carries reused (prior) features because the slot had
   * no fresh/valid frames — a transient degraded-tracking state (Req 3.5).
   */
  degraded: boolean;
}

/**
 * Streaming aggregator over a trailing sliding window.
 *
 * `pushFrame` buffers per-frame features. `advanceWindow` is called on each
 * 1-second tick and returns the AggregatedWindow for the trailing 5 seconds.
 */
export interface FeatureAggregator {
  /** Buffer one per-frame feature sample. */
  pushFrame(f: FeatureFrame): void;
  /**
   * Advance the window by one step and emit the aggregated features for the
   * trailing span. When the slot has no fresh frames, the previous aggregated
   * features are reused and the result is marked `degraded`.
   */
  advanceWindow(): AggregatedWindow;
}

/** Options for {@link SlidingFeatureAggregator}. */
export interface AggregatorOptions {
  /** Trailing window span in ms. Defaults to {@link WINDOW_MS} (5000). */
  windowMs?: number;
  /** Advance step in ms. Defaults to {@link STEP_MS} (1000). */
  stepMs?: number;
}

function isFiniteNumber(n: number): boolean {
  return typeof n === "number" && Number.isFinite(n);
}

/**
 * Trailing sliding-window Feature_Aggregator (Req 3.3, 3.5).
 *
 * The window boundary advances by exactly `stepMs` on every `advanceWindow`
 * call, independent of frame jitter, so consecutive windows start exactly one
 * step apart and each spans the trailing `windowMs` (Property 7). The window
 * end is anchored to the latest pushed frame timestamp on the first advance,
 * then advanced deterministically by `stepMs` thereafter.
 */
export class SlidingFeatureAggregator implements FeatureAggregator {
  private readonly windowMs: number;
  private readonly stepMs: number;

  /** Buffered frames, kept only while they can fall inside a future window. */
  private readonly frames: FeatureFrame[] = [];

  /** Exclusive end of the next window to emit; null until the first advance. */
  private nextEndT: number | null = null;

  /** The most recently emitted aggregate, reused on a degraded slot. */
  private lastWindow: AggregatedWindow | null = null;

  constructor(options: AggregatorOptions = {}) {
    this.windowMs = options.windowMs ?? WINDOW_MS;
    this.stepMs = options.stepMs ?? STEP_MS;
  }

  pushFrame(f: FeatureFrame): void {
    if (!isFiniteNumber(f.t)) {
      return;
    }
    this.frames.push(f);
    // Keep insertion order sorted by timestamp so pruning by start boundary is
    // correct even if frames arrive slightly out of order.
    if (
      this.frames.length > 1 &&
      f.t < this.frames[this.frames.length - 2].t
    ) {
      this.frames.sort((a, b) => a.t - b.t);
    }
  }

  advanceWindow(): AggregatedWindow {
    const endT = this.resolveNextEnd();
    const startT = endT - this.windowMs;

    // Advance the boundary for the next call by exactly one step so successive
    // windows start exactly `stepMs` apart (Property 7).
    this.nextEndT = endT + this.stepMs;

    // Drop frames that can never fall into this or any future window.
    this.pruneBefore(startT);

    // Frames inside the trailing [startT, endT) span.
    const inWindow = this.frames.filter((f) => f.t >= startT && f.t < endT);

    if (inWindow.length === 0) {
      // No fresh/valid data for this slot: reuse prior aggregated features and
      // mark degraded (Req 3.5). If there is no prior window yet, emit a
      // well-formed zeroed window still flagged degraded.
      const reused = this.lastWindow;
      const degraded: AggregatedWindow = reused
        ? { ...reused, startT, endT, frames: 0, degraded: true }
        : {
            ear: 0,
            blinkRate: 0,
            saccadeVelocity: 0,
            frames: 0,
            startT,
            endT,
            degraded: true,
          };
      // Do not overwrite lastWindow with a degraded slot — we want to keep the
      // last *fresh* aggregate available for the next dropout.
      return degraded;
    }

    const window = this.aggregate(inWindow, startT, endT);
    this.lastWindow = window;
    return window;
  }

  /** Resolve the exclusive end timestamp of the window to emit now. */
  private resolveNextEnd(): number {
    if (this.nextEndT !== null) {
      return this.nextEndT;
    }
    // First advance: anchor the end to the latest pushed frame so the first
    // window spans the trailing `windowMs` ending at "now". With no frames yet
    // the end anchors at 0.
    if (this.frames.length === 0) {
      return 0;
    }
    return this.frames[this.frames.length - 1].t;
  }

  /** Remove buffered frames strictly before `startT` (no longer reachable). */
  private pruneBefore(startT: number): void {
    let drop = 0;
    while (drop < this.frames.length && this.frames[drop].t < startT) {
      drop++;
    }
    if (drop > 0) {
      this.frames.splice(0, drop);
    }
  }

  /** Compute the aggregate over a non-empty set of in-window frames. */
  private aggregate(
    inWindow: readonly FeatureFrame[],
    startT: number,
    endT: number,
  ): AggregatedWindow {
    let earSum = 0;
    let velSum = 0;
    let blinks = 0;

    for (const f of inWindow) {
      earSum += isFiniteNumber(f.ear) && f.ear >= 0 ? f.ear : 0;
      velSum +=
        isFiniteNumber(f.saccadeVelocity) && f.saccadeVelocity >= 0
          ? f.saccadeVelocity
          : 0;
      blinks += f.blink === 1 ? 1 : 0;
    }

    const n = inWindow.length;
    const windowSeconds = this.windowMs / 1000;
    // blinkRate = blinks_in_window / windowSeconds * 60 (blinks/min).
    const blinkRate = windowSeconds > 0 ? (blinks / windowSeconds) * 60 : 0;

    return {
      ear: earSum / n,
      blinkRate,
      saccadeVelocity: velSum / n,
      frames: n,
      startT,
      endT,
      degraded: false,
    };
  }
}

/** Create a trailing sliding-window Feature_Aggregator. */
export function createFeatureAggregator(
  options?: AggregatorOptions,
): FeatureAggregator {
  return new SlidingFeatureAggregator(options);
}
