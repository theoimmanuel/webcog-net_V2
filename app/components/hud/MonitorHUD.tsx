"use client";

// Feature: webcog-net-site
//
// Monitor HUD (Req 9) — the researcher-facing live overlay used in Scenario C.
//
// Renders the current physiological signals (EAR, Blink rate, Saccade velocity),
// inference latency, and the Cognitive_Load_State from the latest LoadSample
// (Req 9.1, 9.2, Property 21). The parent (ScenarioC / harness) subscribes to the
// active CognitiveLoadSource and passes the latest sample down via the `sample`
// prop; React state updates are immediate so the display reflects each new cycle
// well within 100 ms (Req 9.2).
//
// Staleness (Req 9.3, Property 22): a timer (default 2000 ms) is reset on every
// new sample. If no new sample arrives before it elapses, the HUD shows a visible
// STALE indicator while RETAINING the last known values unchanged. A fresh sample
// clears the stale state.
//
// A persistent "SIMULATED INPUT ACTIVE" indicator is shown whenever the latest
// sample has `simulated: true` (Req 5.4).
//
// Controls (Req 9.4): a Simulated_Trigger control (LOW/MODERATE/HIGH buttons
// wired to `onSimulate` -> SimulatedTrigger.set), a force-declutter control
// (`onForceDeclutter` -> InterventionEngine.forceDeclutter, Req 9.5), and a reset
// control (`onReset` -> InterventionEngine.reset, Req 9.6).
//
// The data source and controls are injectable props so the component is reusable
// and testable in isolation; `nowFn` injects the clock for deterministic tests.
// Tailwind styling mirrors the dark `.hud` panel ported from `scenario-c.html`.

import { useCallback, useEffect, useRef, useState } from "react";
import {
  type CognitiveLoadState,
  type LoadSample,
  COGNITIVE_LOAD_STATES,
} from "@/lib/load/source";

/** Default interval (ms) after which, with no new sample, values are stale (Req 9.3). */
export const DEFAULT_STALE_MS = 2000;

export interface MonitorHUDProps {
  /**
   * The latest emitted sample, or null before the first emission. The parent
   * subscribes to the active CognitiveLoadSource/controller and passes the most
   * recent sample here (Req 9.1, 9.2, Property 21).
   */
  sample: LoadSample | null;
  /** Set the Simulated_Trigger to a chosen defined state (Req 9.4) — wire to SimulatedTrigger.set. */
  onSimulate: (state: CognitiveLoadState) => void;
  /** Apply the Adaptive_Intervention immediately (Req 9.5) — wire to InterventionEngine.forceDeclutter. */
  onForceDeclutter: () => void;
  /** Restore the initial cluttered state and clear simulation (Req 9.6) — wire to InterventionEngine.reset. */
  onReset: () => void;
  /** Ms without a new sample before values are marked stale (Req 9.3). Defaults to {@link DEFAULT_STALE_MS}. */
  staleMs?: number;
  /** Injectable clock for tests. Defaults to `Date.now`. */
  nowFn?: () => number;
}

/** Format a numeric metric for display, retaining the last value when absent. */
function fmt(value: number | undefined, digits: number, suffix = ""): string {
  if (value === undefined || Number.isNaN(value)) {
    return "—";
  }
  return `${value.toFixed(digits)}${suffix}`;
}

/** Visual accent for each discrete state, matching the prototype's palette. */
const STATE_STYLES: Record<CognitiveLoadState, string> = {
  LOW: "bg-emerald-950 text-emerald-400",
  MODERATE: "bg-amber-950 text-amber-400",
  HIGH: "bg-red-950 text-red-400",
};

/**
 * The Monitor HUD overlay. Pure presentational + a staleness timer; all data and
 * actions arrive via props so it is reusable and testable (Req 9).
 */
export default function MonitorHUD({
  sample,
  onSimulate,
  onForceDeclutter,
  onReset,
  staleMs = DEFAULT_STALE_MS,
  nowFn = Date.now,
}: MonitorHUDProps) {
  // `stale` reflects whether >= staleMs has elapsed with no new sample (Req 9.3).
  const [stale, setStale] = useState(false);
  // Track the identity of the last sample we reacted to so the timer resets only
  // on a genuinely new emission (identity + timestamp).
  const lastSeen = useRef<LoadSample | null>(null);

  // --- Draggable panel ------------------------------------------------------
  // The HUD is draggable by its header so the researcher can move it off the
  // booking content (e.g. flight pricing) it would otherwise cover. `pos` is
  // null until the first drag, so the panel keeps its default top/right CSS
  // anchor; once dragged it switches to absolute left/top in viewport pixels.
  const panelRef = useRef<HTMLElement | null>(null);
  const [pos, setPos] = useState<{ left: number; top: number } | null>(null);
  // Pointer offset between the cursor and the panel's top-left at drag start.
  const dragOffset = useRef<{ dx: number; dy: number } | null>(null);

  const onDragPointerMove = useCallback((e: PointerEvent) => {
    const offset = dragOffset.current;
    if (!offset) return;
    const panel = panelRef.current;
    const width = panel?.offsetWidth ?? 0;
    const height = panel?.offsetHeight ?? 0;
    // Clamp so the panel can never be dragged fully off-screen.
    const maxLeft = Math.max(0, window.innerWidth - width);
    const maxTop = Math.max(0, window.innerHeight - height);
    const left = Math.min(Math.max(0, e.clientX - offset.dx), maxLeft);
    const top = Math.min(Math.max(0, e.clientY - offset.dy), maxTop);
    setPos({ left, top });
  }, []);

  const onDragPointerUp = useCallback(() => {
    dragOffset.current = null;
    window.removeEventListener("pointermove", onDragPointerMove);
    window.removeEventListener("pointerup", onDragPointerUp);
  }, [onDragPointerMove]);

  const onDragStart = useCallback(
    (e: React.PointerEvent<HTMLElement>) => {
      // Only start a drag from a primary button / touch / pen press.
      if (e.button !== 0) return;
      const panel = panelRef.current;
      if (!panel) return;
      const rect = panel.getBoundingClientRect();
      dragOffset.current = { dx: e.clientX - rect.left, dy: e.clientY - rect.top };
      // Anchor to the current rendered position before switching to left/top so
      // the panel doesn't jump on the first move.
      setPos({ left: rect.left, top: rect.top });
      window.addEventListener("pointermove", onDragPointerMove);
      window.addEventListener("pointerup", onDragPointerUp);
    },
    [onDragPointerMove, onDragPointerUp],
  );

  // Clean up listeners if the component unmounts mid-drag.
  useEffect(() => {
    return () => {
      window.removeEventListener("pointermove", onDragPointerMove);
      window.removeEventListener("pointerup", onDragPointerUp);
    };
  }, [onDragPointerMove, onDragPointerUp]);

  useEffect(() => {
    // No sample yet: nothing to measure staleness against.
    if (sample === null) {
      return;
    }
    // A new sample arrived: clear stale and (re)arm the staleness timer. The
    // last known values are kept in `sample` regardless of staleness (Req 9.3).
    lastSeen.current = sample;
    setStale(false);

    const armedAt = nowFn();
    const timer = setTimeout(() => {
      // Only mark stale if no newer sample has superseded this one.
      if (lastSeen.current === sample && nowFn() - armedAt >= staleMs - 1) {
        setStale(true);
      }
    }, staleMs);

    return () => clearTimeout(timer);
    // Re-run whenever a new sample object or the stale window changes.
  }, [sample, staleMs, nowFn]);

  const state = sample?.state;
  const simulated = sample?.simulated ?? false;

  return (
    <section
      ref={panelRef}
      aria-label="WebCog-Net monitor"
      className={`fixed z-[2000] w-64 rounded-xl border border-slate-700 bg-[#0d1117] p-4 font-sans text-[13px] text-slate-200 shadow-2xl ${
        pos ? "" : "right-3.5 top-9"
      }`}
      style={pos ? { left: pos.left, top: pos.top, right: "auto" } : undefined}
    >
      <h3
        onPointerDown={onDragStart}
        className="mb-2.5 flex touch-none cursor-grab items-center gap-1.5 text-sm font-semibold text-sky-400 active:cursor-grabbing"
        title="Drag to move"
      >
        <span
          aria-hidden="true"
          className={`inline-block h-2 w-2 rounded-full ${
            state === "HIGH" ? "bg-red-400" : "bg-emerald-400"
          }`}
        />
        WebCog-Net Monitor
        <span aria-hidden="true" className="ml-auto select-none text-slate-600">
          ⠿
        </span>
      </h3>

      {/* Metrics (Req 9.1). Values are retained across stale periods (Req 9.3). */}
      <dl className="m-0">
        <Metric label="EAR" value={fmt(sample?.ear, 2)} />
        <Metric
          label="Blink rate"
          value={
            sample ? `${Math.round(sample.blinkRate)} /min` : "—"
          }
        />
        <Metric
          label="Saccade vel."
          value={
            sample ? `${Math.round(sample.saccadeVelocity)} °/s` : "—"
          }
        />
        <Metric label="Inference" value={fmt(sample?.latencyMs, 1, " ms")} />
      </dl>

      {/* Cognitive_Load_State (Req 9.1). aria-live so screen readers announce changes. */}
      <div
        aria-live="polite"
        className={`my-2 rounded-md py-1.5 text-center font-bold ${
          state ? STATE_STYLES[state] : "bg-slate-800 text-slate-400"
        }`}
      >
        {state ? `LOAD: ${state}` : "LOAD: —"}
      </div>

      {/* Stale indicator — retains last values while visible (Req 9.3, Property 22). */}
      {stale && (
        <div
          role="status"
          aria-live="polite"
          className="my-2 rounded-md border border-amber-500/50 bg-amber-950 py-1 text-center text-[11px] font-bold uppercase tracking-wide text-amber-400"
        >
          ⚠ STALE — no recent cycle
        </div>
      )}

      {/* Persistent simulated-input indicator (Req 5.4). */}
      {simulated && (
        <div
          role="status"
          className="my-2 rounded-md border border-sky-500/50 bg-sky-950 py-1 text-center text-[11px] font-bold uppercase tracking-wide text-sky-300"
        >
          SIMULATED INPUT ACTIVE
        </div>
      )}

      {/* Simulated_Trigger control (Req 9.4). */}
      <fieldset className="mt-3 border-0 p-0">
        <legend className="mb-1 block text-[11px] text-slate-400">
          Simulated trigger
        </legend>
        <div className="flex gap-1.5">
          {COGNITIVE_LOAD_STATES.map((s) => (
            <button
              key={s}
              type="button"
              onClick={() => onSimulate(s)}
              className="flex-1 cursor-pointer rounded-md border border-slate-700 bg-[#1e3a5f] px-2 py-1.5 text-xs text-slate-200 hover:bg-[#2a4e7a]"
            >
              {s}
            </button>
          ))}
        </div>
      </fieldset>

      {/* Force-declutter (Req 9.5) + Reset (Req 9.6). */}
      <div className="mt-2 flex gap-1.5">
        <button
          type="button"
          onClick={onForceDeclutter}
          className="flex-1 cursor-pointer rounded-md border border-slate-700 bg-[#1e3a5f] px-2 py-1.5 text-xs text-slate-200 hover:bg-[#2a4e7a]"
        >
          Force declutter
        </button>
        <button
          type="button"
          onClick={onReset}
          className="flex-1 cursor-pointer rounded-md border border-slate-700 bg-[#1e3a5f] px-2 py-1.5 text-xs text-slate-200 hover:bg-[#2a4e7a]"
        >
          Reset UI
        </button>
      </div>

      <p className="mt-2 text-[11px] leading-snug text-slate-500">
        Auto-declutters when load stays HIGH for ~3s. The real signal comes from
        the on-device CNN-GRU over a 5s window.
      </p>
    </section>
  );
}

/** A single label/value metric row in the HUD. */
function Metric({ label, value }: { label: string; value: string }) {
  return (
    <div className="mb-1.5 flex justify-between text-slate-400">
      <dt>{label}</dt>
      <dd className="m-0 tabular-nums text-slate-200">{value}</dd>
    </div>
  );
}
