// Feature: webcog-net-site
//
// Cognitive-load source abstraction (Req 5) and the LoadSourceController that
// owns the currently active source.
//
// A `CognitiveLoadSource` is a strategy that produces a stream of `LoadSample`s
// describing the current cognitive-load state plus the physiological signals
// (EAR, Blink rate, Saccade velocity) and inference latency that drive it. Two
// concrete sources exist: the webcam `Vision_Pipeline` (kind "webcam") and the
// `Simulated_Trigger` (kind "simulated", see `simulated.ts`).
//
// Only one source is active at a time. The `LoadSourceController` owns the
// active source, re-emits its samples to its own subscribers so a source switch
// is transparent to downstream consumers (Intervention Engine, Monitor HUD),
// and performs the webcam -> simulated fallback used later by the pipeline
// (Req 3.6, 3.7). Switching the active source completes within one inference
// cycle / 500 ms (Req 5.3). While the simulated source is active the controller
// delivers simulated samples downstream and ignores vision samples (Req 5.2,
// Property 14) — a guarantee that follows structurally from only the active
// source's samples being re-emitted.
//
// This module is pure/DOM-free: the controller just manages sources and
// subscribers, so it is directly unit- and property-testable.

/**
 * The discrete cognitive-load states a source can emit (Req 3.4, 5.1).
 *
 * This is the canonical definition of the type (the design treats `source.ts`
 * as its owner). It is intentionally identical to the union declared in
 * `lib/vision/classifier.ts`; the two unions are structurally compatible so a
 * classifier result can be used wherever a `CognitiveLoadState` is expected and
 * vice versa, without either module depending on the other.
 */
export type CognitiveLoadState = "LOW" | "MODERATE" | "HIGH";

/** The defined discrete states, in LOW..HIGH order. Used for validation. */
export const COGNITIVE_LOAD_STATES: readonly CognitiveLoadState[] = [
  "LOW",
  "MODERATE",
  "HIGH",
];

/**
 * Narrowing guard: whether an arbitrary value is one of the defined discrete
 * Cognitive_Load_State values (Req 5.1, 5.5). Used by the Simulated_Trigger to
 * reject invalid selections (Property 15).
 */
export function isCognitiveLoadState(value: unknown): value is CognitiveLoadState {
  return (
    typeof value === "string" &&
    (COGNITIVE_LOAD_STATES as readonly string[]).includes(value)
  );
}

/**
 * The maximum time, in milliseconds, within which switching the active source
 * must take effect (Req 5.3): one inference cycle, not exceeding 500 ms. The
 * controller's switch is synchronous, so it always satisfies this bound; the
 * constant documents the contract and is available to callers/tests.
 */
export const SOURCE_SWITCH_DEADLINE_MS = 500;

/**
 * One emitted cognitive-load reading. Matches the shape in design.md and is the
 * single payload every downstream consumer (Intervention Engine, Monitor HUD)
 * subscribes to.
 */
export interface LoadSample {
  /** The current discrete cognitive-load state (Req 3.4). */
  state: CognitiveLoadState;
  /** Eye Aspect Ratio — unitless, non-negative (Req 3.2). */
  ear: number;
  /** Blink rate in blinks/min, non-negative (Req 3.2). */
  blinkRate: number;
  /** Saccade velocity in deg/s, non-negative (Req 3.2). */
  saccadeVelocity: number;
  /** Inference latency in milliseconds (Req 4.2). */
  latencyMs: number;
  /** Emission time as `performance.now()`-based epoch ms. */
  timestamp: number;
  /** True when tracking is degraded (transient face loss, Req 3.5). */
  degraded: boolean;
  /** True when produced by the Simulated_Trigger (Req 5.4). */
  simulated: boolean;
}

/** Callback invoked with each emitted sample. */
export type LoadSampleListener = (sample: LoadSample) => void;

/** An unsubscribe function returned by `subscribe`. */
export type Unsubscribe = () => void;

/**
 * The cognitive-load source strategy contract (design.md §CognitiveLoadSource,
 * Req 5.2). Only one source is active at a time; switching sources must take
 * effect within one inference cycle / 500 ms (Req 5.3).
 */
export interface CognitiveLoadSource {
  /** Whether this source is the webcam pipeline or the simulated trigger. */
  readonly kind: "webcam" | "simulated";
  /** Begin producing samples (e.g. open the webcam, start the sim loop). */
  start(): Promise<void>;
  /** Stop producing samples and release any resources. */
  stop(): void;
  /** Subscribe to emitted samples; returns an unsubscribe function. */
  subscribe(cb: LoadSampleListener): Unsubscribe;
  /** The most recently emitted sample, or null before the first emission. */
  latest(): LoadSample | null;
}

/**
 * A small reusable publish/subscribe helper shared by the controller and the
 * simulated source. Keeps subscriber bookkeeping in one place and guarantees an
 * unsubscribe only removes its own callback (idempotent).
 */
export class SampleEmitter {
  private readonly listeners = new Set<LoadSampleListener>();
  private last: LoadSample | null = null;

  /** Subscribe and return an idempotent unsubscribe function. */
  subscribe(cb: LoadSampleListener): Unsubscribe {
    this.listeners.add(cb);
    return () => {
      this.listeners.delete(cb);
    };
  }

  /** Record and broadcast a sample to all current subscribers. */
  emit(sample: LoadSample): void {
    this.last = sample;
    // Snapshot so a listener that (un)subscribes during dispatch is safe.
    for (const listener of [...this.listeners]) {
      listener(sample);
    }
  }

  /** The most recently emitted sample, or null. */
  latest(): LoadSample | null {
    return this.last;
  }

  /** Remove all subscribers (used when tearing down). */
  clear(): void {
    this.listeners.clear();
  }
}

/**
 * Owns the currently active `CognitiveLoadSource` and re-emits its samples to
 * the controller's own subscribers so a source switch is transparent (Req 5.2,
 * 5.3). Downstream consumers (Intervention Engine, HUD) subscribe to the
 * controller, not to a concrete source, so swapping webcam <-> simulated never
 * changes who they listen to.
 *
 * Switching is synchronous: `setActiveSource` unsubscribes from the previous
 * source and subscribes to the new one in the same call, so the new source's
 * samples reach downstream on its next emission — well within one inference
 * cycle / 500 ms (Req 5.3). Because only the active source's samples are
 * re-emitted, while the simulated source is active the controller delivers the
 * simulated state downstream and ignores vision states (Property 14).
 */
export class LoadSourceController {
  private readonly emitter = new SampleEmitter();

  /** The active source, or null before one is set. */
  private active: CognitiveLoadSource | null = null;

  /** Unsubscribe handle for the active source's subscription. */
  private detach: Unsubscribe | null = null;

  /** The current active source, or null. */
  getActiveSource(): CognitiveLoadSource | null {
    return this.active;
  }

  /** The `kind` of the active source, or null when none is set. */
  getActiveKind(): CognitiveLoadSource["kind"] | null {
    return this.active ? this.active.kind : null;
  }

  /**
   * Make `source` the active source. Detaches from the previous source (without
   * stopping it — ownership of lifecycle stays with the caller) and re-emits the
   * new source's samples to the controller's subscribers.
   *
   * The switch takes effect immediately on return (Req 5.3): any sample the new
   * source emits afterwards is forwarded downstream, and samples from the old
   * source are no longer forwarded.
   */
  setActiveSource(source: CognitiveLoadSource): void {
    if (source === this.active) {
      return;
    }
    // Stop forwarding the previous source's samples.
    if (this.detach) {
      this.detach();
      this.detach = null;
    }
    this.active = source;
    // Forward the new source's samples transparently to downstream subscribers.
    this.detach = source.subscribe((sample) => this.emitter.emit(sample));

    // Seed downstream with the new source's latest sample (if any) so a switch
    // delivers the active state immediately rather than only on the next cycle.
    const seed = source.latest();
    if (seed) {
      this.emitter.emit(seed);
    }
  }

  /**
   * Switch to the simulated source. This is the webcam -> simulated fallback
   * used by the pipeline on sustained face loss / webcam denial (Req 3.6, 3.7)
   * and by the Researcher toggle (Req 5.3). It is `setActiveSource` specialised
   * to a simulated-kind source for intent clarity at call sites.
   */
  fallbackToSimulated(simulated: CognitiveLoadSource): void {
    this.setActiveSource(simulated);
  }

  /** Subscribe to the active source's samples; returns an unsubscribe. */
  subscribe(cb: LoadSampleListener): Unsubscribe {
    return this.emitter.subscribe(cb);
  }

  /** The latest sample re-emitted from the active source, or null. */
  latest(): LoadSample | null {
    return this.emitter.latest();
  }

  /** Whether the simulated source is the active source (Req 5.2, 5.4). */
  isSimulatedActive(): boolean {
    return this.active?.kind === "simulated";
  }

  /**
   * Detach from the active source and drop all downstream subscribers. Does not
   * stop the underlying source — the caller owns source lifecycles.
   */
  dispose(): void {
    if (this.detach) {
      this.detach();
      this.detach = null;
    }
    this.active = null;
    this.emitter.clear();
  }
}

/** Create a new, empty LoadSourceController. */
export function createLoadSourceController(): LoadSourceController {
  return new LoadSourceController();
}
