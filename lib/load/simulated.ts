// Feature: webcog-net-site
//
// Simulated_Trigger cognitive-load source (Req 5).
//
// A manual fallback source that drives the Cognitive_Load_State directly,
// independently of the Vision_Pipeline (Req 5.1). It is used for machines
// without a webcam, for reliable demonstrations, and as the webcam -> simulated
// fallback target (Req 3.6, 3.7).
//
// `set(state)` makes the source's latest state equal exactly that defined value
// (Req 5.1, Property 13) and synthesises plausible EAR / Blink / Saccade /
// latency metrics — using the same formulas as the approved `scenario-c.html`
// prototype — so the Monitor HUD stays populated. Every emitted `LoadSample`
// carries `simulated: true` (Req 5.4).
//
// Invalid state values (anything other than LOW/MODERATE/HIGH) are rejected:
// the previously active state is retained and an error indication identifying
// the invalid value is surfaced (Req 5.5, Property 15). The error is surfaced
// two ways — `set()` throws a typed `InvalidCognitiveLoadStateError`, and the
// last rejection is also exposed via `lastError()` for UI code that prefers to
// poll rather than catch. In both cases the latest sample is left unchanged.
//
// This module is pure/DOM-free; randomness and the clock are injectable so the
// synthesis is deterministic under test.

import {
  type CognitiveLoadState,
  type CognitiveLoadSource,
  type LoadSample,
  type LoadSampleListener,
  type Unsubscribe,
  SampleEmitter,
  isCognitiveLoadState,
} from "@/lib/load/source";

/**
 * Error thrown by {@link SimulatedTrigger.set} when the requested value is not a
 * defined discrete Cognitive_Load_State. Carries the offending value so the UI
 * can identify it (Req 5.5, Property 15).
 */
export class InvalidCognitiveLoadStateError extends Error {
  /** The invalid value that was rejected. */
  readonly invalidValue: unknown;

  constructor(invalidValue: unknown) {
    super(
      `Invalid Cognitive_Load_State: ${JSON.stringify(invalidValue)}. ` +
        `Expected one of LOW, MODERATE, HIGH.`,
    );
    this.name = "InvalidCognitiveLoadStateError";
    this.invalidValue = invalidValue;
  }
}

/** The Simulated_Trigger contract (design.md §Simulated_Trigger, Req 5). */
export interface SimulatedTrigger extends CognitiveLoadSource {
  kind: "simulated";
  /** Set the simulated state; rejects non-discrete values (Req 5.5). */
  set(state: CognitiveLoadState): void;
}

/** A source of uniform random numbers in [0, 1). Injectable for determinism. */
export type RandomFn = () => number;

/** A monotonic clock in ms. Injectable for determinism (defaults below). */
export type ClockFn = () => number;

/** Options for {@link SimulatedLoadTrigger}. */
export interface SimulatedTriggerOptions {
  /** Initial state before any `set` call. Defaults to "LOW". */
  initialState?: CognitiveLoadState;
  /** Uniform [0,1) RNG for metric jitter. Defaults to `Math.random`. */
  random?: RandomFn;
  /** Timestamp source for emitted samples. Defaults to `performance.now()`. */
  clock?: ClockFn;
}

/**
 * Representative "load %" (0..100) for each discrete state, used to drive the
 * prototype's metric formulas. The prototype treats >= 65 as HIGH and >= 40 as
 * MODERATE; these anchors sit in the middle of each band so the synthesised
 * metrics look typical for the state.
 */
const STATE_LOAD_PERCENT: Record<CognitiveLoadState, number> = {
  LOW: 20,
  MODERATE: 50,
  HIGH: 85,
};

function defaultClock(): number {
  if (typeof performance !== "undefined" && typeof performance.now === "function") {
    return performance.now();
  }
  return Date.now();
}

/**
 * Synthesise plausible physiological metrics for a given load percentage, using
 * the exact relationships from `scenario-c.html`:
 *   - EAR drops under load:            0.30 - load/100 * 0.10 + jitter(-0.01, 0.01)
 *   - Blink rate drops under load:     max(2, round(18 - load/100 * 14 + jitter(-1, 1)))
 *   - Saccade velocity rises:          round(180 + load/100 * 420 + jitter(-20, 20))
 *   - Inference latency (< 5 ms):      2.2 + jitter(-0.6, 0.9)
 * All values are clamped to be non-negative so they satisfy Property 6's
 * well-formedness expectations even at extreme jitter.
 */
export function synthesizeMetrics(
  loadPercent: number,
  random: RandomFn,
): { ear: number; blinkRate: number; saccadeVelocity: number; latencyMs: number } {
  const load = Math.min(100, Math.max(0, loadPercent));
  const jitter = (a: number, b: number): number => a + random() * (b - a);

  const ear = Math.max(0, 0.3 - (load / 100) * 0.1 + jitter(-0.01, 0.01));
  const blinkRate = Math.max(
    2,
    Math.round(18 - (load / 100) * 14 + jitter(-1, 1)),
  );
  const saccadeVelocity = Math.max(
    0,
    Math.round(180 + (load / 100) * 420 + jitter(-20, 20)),
  );
  const latencyMs = Math.max(0, 2.2 + jitter(-0.6, 0.9));

  return { ear, blinkRate, saccadeVelocity, latencyMs };
}

/**
 * Concrete Simulated_Trigger (Req 5). Holds the current state, synthesises
 * metrics on each `set`, and emits `simulated: true` samples to subscribers.
 */
export class SimulatedLoadTrigger implements SimulatedTrigger {
  readonly kind = "simulated" as const;

  private readonly emitter = new SampleEmitter();
  private readonly random: RandomFn;
  private readonly clock: ClockFn;

  /** The currently active simulated state (retained on invalid `set`). */
  private state: CognitiveLoadState;

  /** Whether the sim loop is "running"; samples are only emitted while running. */
  private running = false;

  /** The last rejection, surfaced for poll-style UIs (Req 5.5). */
  private lastErr: InvalidCognitiveLoadStateError | null = null;

  constructor(options: SimulatedTriggerOptions = {}) {
    this.state = options.initialState ?? "LOW";
    this.random = options.random ?? Math.random;
    this.clock = options.clock ?? defaultClock;
  }

  /**
   * Begin emitting. Emits an initial sample for the current state so downstream
   * (and the HUD) are populated immediately once this source becomes active.
   */
  async start(): Promise<void> {
    this.running = true;
    this.emitCurrent();
  }

  /** Stop emitting. The retained state and latest sample are preserved. */
  stop(): void {
    this.running = false;
  }

  /**
   * Set the simulated state to exactly `state` and emit a fresh sample for it
   * (Req 5.1, Property 13). Rejects any value that is not a defined discrete
   * state: the previously active state is retained, the latest sample is left
   * unchanged, `lastError()` is updated, and an
   * {@link InvalidCognitiveLoadStateError} is thrown (Req 5.5, Property 15).
   */
  set(state: CognitiveLoadState): void {
    if (!isCognitiveLoadState(state)) {
      // Retain prior state; record and surface the invalid value (Req 5.5).
      const error = new InvalidCognitiveLoadStateError(state);
      this.lastErr = error;
      throw error;
    }
    // Valid selection: clear any prior error and adopt exactly this state.
    this.lastErr = null;
    this.state = state;
    this.emitCurrent();
  }

  /** The currently active simulated state. */
  getState(): CognitiveLoadState {
    return this.state;
  }

  /** The last rejected `set` as a typed error, or null if none since the last valid set. */
  lastError(): InvalidCognitiveLoadStateError | null {
    return this.lastErr;
  }

  subscribe(cb: LoadSampleListener): Unsubscribe {
    return this.emitter.subscribe(cb);
  }

  latest(): LoadSample | null {
    return this.emitter.latest();
  }

  /** Build and emit a `simulated: true` sample for the current state. */
  private emitCurrent(): void {
    if (!this.running) {
      // Keep the state updated but don't publish while stopped; the next
      // `start()` will emit the current state.
      return;
    }
    const metrics = synthesizeMetrics(STATE_LOAD_PERCENT[this.state], this.random);
    const sample: LoadSample = {
      state: this.state,
      ear: metrics.ear,
      blinkRate: metrics.blinkRate,
      saccadeVelocity: metrics.saccadeVelocity,
      latencyMs: metrics.latencyMs,
      timestamp: this.clock(),
      degraded: false,
      simulated: true,
    };
    this.emitter.emit(sample);
  }
}

/** Create a Simulated_Trigger source. */
export function createSimulatedTrigger(
  options?: SimulatedTriggerOptions,
): SimulatedLoadTrigger {
  return new SimulatedLoadTrigger(options);
}
