/**
 * Inference-latency statistics (Req 4.4, 4.5).
 *
 * The Classifier wraps each `predict` call in a `performance.now()` delta and
 * feeds the resulting per-inference latency (ms) here. Across a Study_Session
 * we record the mean, maximum, and 95th-percentile latency (Req 4.4) and flag
 * the session as exceeding the latency target when any single inference reaches
 * or exceeds 5 ms (Req 4.5).
 *
 * The classifier's first `predict` is a warmup run performed once during
 * `load()`; it is a cold-start outlier and is excluded from these statistics
 * (design: "First-call warmup is run once during `load()` and excluded as a
 * cold-start outlier"). The {@link LatencyAccumulator} provides an explicit way
 * to record and skip that warmup sample.
 *
 * This module is pure and DOM-free so it is directly unit- and property-testable.
 */

import type { LatencyStats } from "@/lib/harness/session";

/** Latency threshold (ms) at and above which the session exceeds the target (Req 4.5). */
export const LATENCY_TARGET_MS = 5;

/**
 * Stats returned for an empty sample set: all zeros, no samples, not exceeding.
 * Defining this explicitly keeps {@link computeLatencyStats} total (never throws
 * and never returns null) so callers can store a well-formed value even before
 * any inference has run.
 */
const EMPTY_STATS: LatencyStats = {
  meanMs: 0,
  maxMs: 0,
  p95Ms: 0,
  exceedsTarget: false,
  sampleCount: 0,
};

/**
 * Compute the 95th-percentile of a non-empty, ascending-sorted list using
 * linear interpolation between the two closest ranks. The result is guaranteed
 * to lie within [min, max] of the input, which keeps Property 11 intact for
 * any finite inputs.
 */
function percentile95(sortedAsc: number[]): number {
  const n = sortedAsc.length;
  if (n === 1) return sortedAsc[0];
  // Linear-interpolation ("rank = p * (n - 1)") percentile.
  const rank = 0.95 * (n - 1);
  const lowerIndex = Math.floor(rank);
  const upperIndex = Math.ceil(rank);
  const lower = sortedAsc[lowerIndex];
  const upper = sortedAsc[upperIndex];
  if (lowerIndex === upperIndex) return lower;
  const fraction = rank - lowerIndex;
  const value = lower + (upper - lower) * fraction;
  // Clamp to guard against floating-point drift outside [min, max].
  return Math.min(sortedAsc[n - 1], Math.max(sortedAsc[0], value));
}

/**
 * Compute latency statistics across a list of per-inference latency values (ms).
 *
 * - `maxMs` equals the list maximum.
 * - `meanMs` is the arithmetic mean and lies within [min, max].
 * - `p95Ms` is the 95th-percentile and lies within [min, max].
 * - `exceedsTarget` is true iff at least one value is >= {@link LATENCY_TARGET_MS}.
 * - `sampleCount` is the number of values included.
 *
 * Warmup/cold-start exclusion is the caller's responsibility: pass only the
 * samples to be included (see {@link LatencyAccumulator}, which skips warmup).
 *
 * An empty list returns {@link EMPTY_STATS} rather than throwing, so the result
 * is always a well-formed `LatencyStats`.
 */
export function computeLatencyStats(latencies: number[]): LatencyStats {
  if (latencies.length === 0) return { ...EMPTY_STATS };

  const sortedAsc = [...latencies].sort((a, b) => a - b);
  const n = sortedAsc.length;
  const min = sortedAsc[0];
  const max = sortedAsc[n - 1];

  let sum = 0;
  for (const value of latencies) sum += value;
  const meanRaw = sum / n;
  // Clamp the mean into [min, max] to absorb floating-point drift and keep
  // Property 11 ("mean lies between min and max") exact.
  const meanMs = Math.min(max, Math.max(min, meanRaw));

  const p95Ms = percentile95(sortedAsc);

  let exceedsTarget = false;
  for (const value of latencies) {
    if (value >= LATENCY_TARGET_MS) {
      exceedsTarget = true;
      break;
    }
  }

  return {
    meanMs,
    maxMs: max,
    p95Ms,
    exceedsTarget,
    sampleCount: n,
  };
}

/**
 * Accumulates per-inference latencies across a Study_Session and computes
 * {@link LatencyStats} on demand.
 *
 * The classifier's first `predict` is a cold-start warmup run performed during
 * `load()`. Record it via {@link markWarmup} so it is retained for reference but
 * excluded from the statistics (design: warmup excluded as a cold-start outlier).
 * All subsequent samples recorded via {@link add} are included.
 */
export class LatencyAccumulator {
  private readonly samples: number[] = [];
  private warmupMs: number | null = null;

  /**
   * Record the one-time warmup / cold-start latency. It is stored for reference
   * (see {@link getWarmup}) but excluded from {@link stats}. Only the first call
   * sets the warmup; later calls are treated as normal samples via {@link add}
   * so a mistaken double-mark does not silently drop a real measurement.
   */
  markWarmup(latencyMs: number): void {
    if (this.warmupMs === null) {
      this.warmupMs = latencyMs;
      return;
    }
    this.add(latencyMs);
  }

  /** Record one included (non-warmup) inference latency in milliseconds. */
  add(latencyMs: number): void {
    this.samples.push(latencyMs);
  }

  /** The excluded warmup/cold-start latency, or null if none was marked. */
  getWarmup(): number | null {
    return this.warmupMs;
  }

  /** A copy of the included (non-warmup) samples, in insertion order. */
  getSamples(): number[] {
    return [...this.samples];
  }

  /** Number of included (non-warmup) samples. */
  get sampleCount(): number {
    return this.samples.length;
  }

  /** Compute statistics over the included samples (warmup excluded). */
  stats(): LatencyStats {
    return computeLatencyStats(this.samples);
  }
}
