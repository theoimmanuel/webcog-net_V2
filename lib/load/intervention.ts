// Feature: webcog-net-site
//
// Adaptive Intervention engine (Req 8) and its state machine.
//
// The engine owns the Scenario C declutter transition. It applies the
// Adaptive_Intervention by toggling the `calm` class on the attached root (and
// `document.body`), reusing the approved `body.calm` CSS ported from
// `scenario-c.html`: hiding advertisements/marquee/countdown/toasts/pop-ups,
// removing animation, simplifying the palette, and raising main-text contrast
// (Req 8.3). The CSS itself lives with the scenario chrome (task 16.x); this
// module owns only the class toggling and the decluttered/cluttered state
// machine.
//
// Auto-intervention is driven by samples:
//   onSample(s) -> feeds the Sustained_High_Load detector; when a continuous
//                  HIGH run reaches SUSTAIN_MS (3 s) the engine declutters
//                  (Req 8.3, 8.4, Property 18).
// Manual controls, used by the Researcher HUD:
//   forceDeclutter() -> declutters immediately regardless of state, within
//                       200 ms (Req 8.5, 9.5, Property 19).
//   reset()          -> restores the initial cluttered state and clears the
//                       active Simulated_Trigger, within 200 ms (Req 8.6, 9.6,
//                       Property 20).
//
// Both class toggling and the clear-simulated callback are synchronous, so the
// 200 ms bounds are satisfied structurally.
//
// Adaptivity guard (Req 6.4, 7.5, Property 16): a non-adaptive engine (attached
// to Scenario A or B) MUST NEVER auto-intervene from load samples. The engine
// takes an `adaptive` flag; when false, `onSample` never declutters. The manual
// `forceDeclutter`/`reset` controls belong to the Researcher HUD, which only
// exists in Scenario C, so they are unaffected by this guard.
//
// SSR-safe: all DOM access is guarded so the module can be imported in a
// server/SSR context without touching `document`. The engine only mutates the
// DOM once a root element is attached on the client.

import type { LoadSample } from "@/lib/load/source";
import {
  SustainedHighDetector,
  SUSTAIN_MS,
} from "@/lib/load/sustain";

/**
 * The CSS class toggled to apply/remove the Adaptive_Intervention. Matches the
 * `body.calm` selector of the ported `scenario-c.html` chrome (Req 8.3).
 */
export const CALM_CLASS = "calm";

/**
 * The Adaptive Intervention engine contract (design.md §Adaptive Intervention
 * Engine, Req 8).
 */
export interface InterventionEngine {
  /** Attach the engine to the scenario root element it will declutter. */
  attach(rootEl: HTMLElement): void;
  /** Drive sustained-high detection with one load sample (Req 8.4). */
  onSample(s: LoadSample): void;
  /** Manually apply the Adaptive_Intervention within 200 ms (Req 8.5, 9.5). */
  forceDeclutter(): void;
  /** Restore the cluttered state and clear the Simulated_Trigger (Req 8.6, 9.6). */
  reset(): void;
  /** Whether the Adaptive_Intervention is currently applied. */
  isDecluttered(): boolean;
}

/** Options for {@link AdaptiveInterventionEngine}. */
export interface InterventionEngineOptions {
  /**
   * Whether this engine may auto-intervene from load samples. True only for the
   * adaptive scenario (Scenario C). For Scenario A/B this MUST be false so the
   * engine never applies the Adaptive_Intervention from samples (Req 6.4, 7.5,
   * Property 16). Defaults to false — safe by default.
   */
  adaptive?: boolean;
  /**
   * Continuous HIGH duration (ms) required before auto-decluttering. Defaults
   * to {@link SUSTAIN_MS} (3000 ms, Req 8.4). Overridable for tests.
   */
  sustainMs?: number;
  /**
   * Hook invoked by {@link AdaptiveInterventionEngine.reset} to clear any active
   * Simulated_Trigger (Req 8.6, 9.6). The engine itself does not own the
   * controller/source, so the caller wires the clear here. Called synchronously
   * so the 200 ms reset bound holds.
   */
  clearSimulated?: () => void;
}

/**
 * Concrete Adaptive Intervention engine (Req 8). Toggles the `calm` class on
 * the attached root and `document.body`, driven by sustained-high detection for
 * the adaptive scenario and by manual force/reset controls for the HUD.
 */
export class AdaptiveInterventionEngine implements InterventionEngine {
  private readonly adaptive: boolean;
  private readonly detector: SustainedHighDetector;
  private readonly clearSimulated: (() => void) | null;

  /** The attached scenario root, or null before {@link attach}. */
  private root: HTMLElement | null = null;

  /** Whether the Adaptive_Intervention is currently applied. */
  private decluttered = false;

  constructor(options: InterventionEngineOptions = {}) {
    this.adaptive = options.adaptive ?? false;
    this.detector = new SustainedHighDetector(options.sustainMs ?? SUSTAIN_MS);
    this.clearSimulated = options.clearSimulated ?? null;
  }

  /** Attach to the scenario root. Re-attaching re-syncs the class state. */
  attach(rootEl: HTMLElement): void {
    this.root = rootEl;
    // Reflect the current state onto the freshly attached root.
    this.applyClass();
  }

  /**
   * Feed one load sample to the sustained-high detector. In the adaptive
   * scenario, declutter as soon as a continuous HIGH run reaches the threshold
   * (Req 8.3, 8.4, Property 18). In a non-adaptive scenario this NEVER
   * declutters, no matter how long HIGH persists (Req 6.4, 7.5, Property 16);
   * the detector still runs so its state stays meaningful, but its verdict is
   * ignored.
   */
  onSample(s: LoadSample): void {
    const sustained = this.detector.update(s.state, s.timestamp);
    if (!this.adaptive) {
      return;
    }
    if (sustained && !this.decluttered) {
      this.setDecluttered(true);
    }
  }

  /**
   * Apply the Adaptive_Intervention immediately, regardless of the current
   * Cognitive_Load_State (Req 8.5, 9.5, Property 19). Synchronous, so it takes
   * effect well within 200 ms. Available in Scenario C via the HUD.
   */
  forceDeclutter(): void {
    this.setDecluttered(true);
  }

  /**
   * Restore the initial cluttered interface and clear any active
   * Simulated_Trigger (Req 8.6, 9.6, Property 20). Also clears the sustained-high
   * run so a fresh HIGH run must accrue before auto-decluttering again.
   * Synchronous, so it takes effect well within 200 ms.
   */
  reset(): void {
    this.setDecluttered(false);
    this.detector.reset();
    if (this.clearSimulated) {
      this.clearSimulated();
    }
  }

  /** Whether the Adaptive_Intervention is currently applied. */
  isDecluttered(): boolean {
    return this.decluttered;
  }

  /** Set the decluttered flag and reflect it onto the DOM. */
  private setDecluttered(value: boolean): void {
    this.decluttered = value;
    this.applyClass();
  }

  /**
   * Reflect the current `decluttered` state onto the attached root and the
   * document body by toggling {@link CALM_CLASS}. SSR-safe: skips any target
   * that is unavailable (no root attached, or no `document` in this runtime).
   */
  private applyClass(): void {
    if (this.root) {
      this.root.classList.toggle(CALM_CLASS, this.decluttered);
    }
    if (typeof document !== "undefined" && document.body) {
      document.body.classList.toggle(CALM_CLASS, this.decluttered);
    }
  }
}

/** Create an Adaptive Intervention engine. */
export function createInterventionEngine(
  options?: InterventionEngineOptions,
): AdaptiveInterventionEngine {
  return new AdaptiveInterventionEngine(options);
}
