"use client";

/**
 * ScenarioB — the high-cognitive-load scenario view (Req 7).
 *
 * The deliberately overwhelming "SkyBook MEGA" setting ported from the approved
 * prototype `prototype/scenario-b.html`. The clutter (scrolling marquee,
 * sidebar ads, countdown timers, stacking toasts, modal pop-ups, floating chat
 * bubble, cookie banner) is rendered by the shared {@link ScenarioChrome}
 * (Req 7.1). Photosensitive safety — never more than three flashes per second —
 * is already handled inside ScenarioChrome via the `safeFlash` guard, so this
 * view adds no flashing of its own (Req 7.3, 7.4).
 *
 * The participant's Booking_Task instruction is shown (Req 7.2) and the shared
 * {@link BookingTask} is rendered with `scenario="B"` so the booking step
 * sequence is identical across scenarios.
 *
 * No adaptive intervention (Req 7.5): the clutter stays cluttered for the whole
 * scenario. This view never toggles ScenarioChrome's `calm` class and never
 * attaches the intervention engine, so no cognitive-load sample can trigger an
 * auto-declutter. This is a presentational wrapper only; timing/telemetry
 * wiring lives in the harness (task 21.1).
 */

import ScenarioChrome from "@/app/components/scenarios/ScenarioChrome";
import BookingTask from "@/app/components/booking/BookingTask";

/** Props for {@link ScenarioB}. Presentational wrapper around the booking task. */
export interface ScenarioBProps {
  /** Called when the Booking_Task reaches confirmation (Req 11.2). */
  onComplete: () => void;
  /** Optional: called if the participant leaves the task before confirmation. */
  onAbandon?: () => void;
  /**
   * Forwarded to {@link ScenarioChrome}: when false the clutter renders
   * statically with no timers (useful for tests/SSR). Defaults to true.
   */
  animated?: boolean;
}

export default function ScenarioB({
  onComplete,
  onAbandon,
  animated = true,
}: ScenarioBProps) {
  return (
    <div data-scenario="B" className="min-h-screen bg-[#f4ead2]">
      <ScenarioChrome animated={animated}>
        <h1 className="mb-2 text-2xl font-black text-[#8a1a1a]">
          ✈️ FIND YOUR FLIGHT (BEST PRICES GUARANTEED!!!) ✈️
        </h1>

        <div
          role="note"
          className="mb-3 border-2 border-dotted border-[#f1c40f] bg-[#2a2a2a] px-3 py-2 font-bold text-[#f1c40f]"
        >
          YOUR TASK: find the cheapest morning flight Jakarta → Bali and start
          booking it.
        </div>

        <BookingTask
          scenario="B"
          onComplete={onComplete}
          onAbandon={onAbandon}
        />
      </ScenarioChrome>
    </div>
  );
}
