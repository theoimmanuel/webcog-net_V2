"use client";

/**
 * ScenarioA — the baseline, calm scenario view (Req 6).
 *
 * A quiet, low-cognitive-load setting ported from the approved prototype
 * `prototype/scenario-a.html`: a dark, single-column layout with generous
 * spacing, a simple header, and NO animated elements — no marquees, no
 * countdowns, no pop-ups, no stacking toasts, no animated ads (Req 6.1,
 * 6.3). The participant's Booking_Task instruction is shown in a calm note
 * (Req 6.2), and the shared {@link BookingTask} is rendered with
 * `scenario="A"` so the step sequence is identical across scenarios.
 *
 * No adaptive intervention (Req 6.4): this view deliberately does NOT render
 * the high-clutter {@link ScenarioChrome} and never attaches the intervention
 * engine. There is simply nothing to declutter — the layout is calm from the
 * start and stays that way regardless of any cognitive-load samples. This
 * component is a presentational wrapper only; timing/telemetry wiring lives in
 * the harness (task 21.1).
 */

import BookingTask from "@/app/components/booking/BookingTask";

/** Props for {@link ScenarioA}. Presentational wrapper around the booking task. */
export interface ScenarioAProps {
  /** Called when the Booking_Task reaches confirmation (Req 11.2). */
  onComplete: () => void;
  /** Optional: called if the participant leaves the task before confirmation. */
  onAbandon?: () => void;
}

export default function ScenarioA({ onComplete, onAbandon }: ScenarioAProps) {
  return (
    <div
      data-scenario="A"
      className="min-h-screen bg-[#0f1419] text-[#e6edf3] antialiased"
    >
      <header className="border-b border-[#2d3a48] bg-[#1a222c]">
        <div className="mx-auto flex max-w-[880px] items-center justify-between px-8 py-5">
          <div className="text-[22px] font-semibold tracking-wide text-[#4a9eff]">
            SkyBook
          </div>
          <nav aria-label="Primary">
            <ul className="flex list-none gap-7 text-[15px] text-[#9aa7b4]">
              <li><a href="#" className="hover:text-[#e6edf3]">Flights</a></li>
              <li><a href="#" className="hover:text-[#e6edf3]">Hotels</a></li>
              <li><a href="#" className="hover:text-[#e6edf3]">Trips</a></li>
              <li><a href="#" className="hover:text-[#e6edf3]">Help</a></li>
            </ul>
          </nav>
        </div>
      </header>

      <main className="py-14">
        <div className="mx-auto max-w-[880px] px-8">
          <h1 className="mb-3 text-[30px] font-semibold leading-tight">
            Find your next flight
          </h1>
          <p className="mb-10 max-w-[620px] leading-relaxed text-[#9aa7b4]">
            A quiet, focused way to search and book. One task at a time, nothing
            competing for your attention.
          </p>

          <div
            role="note"
            className="mb-8 rounded-lg border border-[#4a9eff] bg-[#1e3a5f] px-5 py-4 text-[15px]"
          >
            Your task: find the cheapest morning flight from Jakarta to Bali and
            start booking it.
          </div>

          <BookingTask
            scenario="A"
            onComplete={onComplete}
            onAbandon={onAbandon}
          />
        </div>
      </main>
    </div>
  );
}
