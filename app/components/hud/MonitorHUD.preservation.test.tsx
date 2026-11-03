// Feature: webcam-no-face-detection (bugfix spec)
//
// Property 2: Preservation - Monitor HUD behaviour (Req 3.7, 3.8).
//
// Observed on UNFIXED code and asserted here so the face-visibility enhancement
// cannot regress it:
//   8. A simulated sample shows SIMULATED INPUT ACTIVE and no
//      "FACE DETECTED" / "NO FACE DETECTED" text (Req 3.7).
//   9. The STALE indicator appears only once `staleMs` elapses with no new
//      sample (last values retained) and a fresh sample clears it; the
//      simulate / force-declutter / reset controls invoke their handlers exactly
//      once per click (Req 3.8).
//
// **Validates: Requirements 3.7, 3.8**

import { describe, it, expect, vi, afterEach } from "vitest";
import { render, screen, cleanup, act } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import fc from "fast-check";
import MonitorHUD from "./MonitorHUD";
import { COGNITIVE_LOAD_STATES, type LoadSample } from "@/lib/load/source";

const FACE_TEXT = /FACE DETECTED/i;

const sampleArb = (simulated: boolean): fc.Arbitrary<LoadSample> =>
  fc.record({
    state: fc.constantFrom(...COGNITIVE_LOAD_STATES),
    ear: fc.double({ min: 0, max: 0.5, noNaN: true }),
    blinkRate: fc.double({ min: 0, max: 40, noNaN: true }),
    saccadeVelocity: fc.double({ min: 0, max: 800, noNaN: true }),
    latencyMs: fc.double({ min: 0, max: 10, noNaN: true }),
    timestamp: fc.integer({ min: 0, max: 1_000_000 }),
    degraded: fc.boolean(),
    simulated: fc.constant(simulated),
  });

const noop = () => {};

afterEach(() => {
  vi.useRealTimers();
  cleanup();
});

describe("Property 2 (case 8): simulated HUD shows SIMULATED INPUT ACTIVE and no face banner", () => {
  it("for any simulated sample", () => {
    fc.assert(
      fc.property(sampleArb(true), (sample) => {
        render(
          <MonitorHUD
            sample={sample}
            onSimulate={noop}
            onForceDeclutter={noop}
            onReset={noop}
          />,
        );
        try {
          expect(screen.getByText("SIMULATED INPUT ACTIVE")).toBeInTheDocument();
          expect(screen.getByText(`LOAD: ${sample.state}`)).toBeInTheDocument();
          expect(screen.queryByText(FACE_TEXT)).toBeNull();
        } finally {
          cleanup();
        }
      }),
      { numRuns: 30 },
    );
  });
});

describe("Property 2 (case 9): STALE indicator and HUD controls are unchanged", () => {
  it("STALE appears only after staleMs with no new sample, retains values, and clears on a fresh sample", () => {
    fc.assert(
      fc.property(
        fc.integer({ min: 200, max: 5000 }),
        fc.boolean(),
        sampleArb(true),
        sampleArb(false),
        (staleMs, useSimulated, simSample, camSample) => {
          vi.useFakeTimers();
          const sample = useSimulated ? simSample : camSample;
          const { rerender } = render(
            <MonitorHUD
              sample={sample}
              onSimulate={noop}
              onForceDeclutter={noop}
              onReset={noop}
              staleMs={staleMs}
            />,
          );
          try {
            const stale = () => screen.queryByText(/STALE/);
            expect(stale()).toBeNull();

            act(() => {
              vi.advanceTimersByTime(staleMs - 1);
            });
            expect(stale()).toBeNull();

            act(() => {
              vi.advanceTimersByTime(1);
            });
            expect(stale()).toBeInTheDocument();
            // Last known values are retained while stale.
            expect(screen.getByText(`LOAD: ${sample.state}`)).toBeInTheDocument();
            expect(screen.getByText(`${Math.round(sample.blinkRate)} /min`)).toBeInTheDocument();

            // A fresh sample clears the stale state.
            rerender(
              <MonitorHUD
                sample={{ ...sample, timestamp: sample.timestamp + 1 }}
                onSimulate={noop}
                onForceDeclutter={noop}
                onReset={noop}
                staleMs={staleMs}
              />,
            );
            expect(stale()).toBeNull();
          } finally {
            cleanup();
            vi.useRealTimers();
          }
        },
      ),
      { numRuns: 25 },
    );
  });

  it("no STALE indicator before the first sample", () => {
    vi.useFakeTimers();
    render(
      <MonitorHUD sample={null} onSimulate={noop} onForceDeclutter={noop} onReset={noop} />,
    );
    act(() => {
      vi.advanceTimersByTime(10_000);
    });
    expect(screen.queryByText(/STALE/)).toBeNull();
    expect(screen.queryByText("SIMULATED INPUT ACTIVE")).toBeNull();
  });

  it("simulate / force-declutter / reset invoke their handlers exactly once per click", async () => {
    await fc.assert(
      fc.asyncProperty(
        fc.array(
          fc.constantFrom("LOW", "MODERATE", "HIGH", "Force declutter", "Reset UI"),
          { minLength: 1, maxLength: 8 },
        ),
        fc.option(sampleArb(true), { nil: null }),
        async (clicks, sample) => {
          const onSimulate = vi.fn();
          const onForceDeclutter = vi.fn();
          const onReset = vi.fn();
          const user = userEvent.setup();
          render(
            <MonitorHUD
              sample={sample}
              onSimulate={onSimulate}
              onForceDeclutter={onForceDeclutter}
              onReset={onReset}
            />,
          );
          try {
            for (const label of clicks) {
              await user.click(screen.getByRole("button", { name: label }));
            }
            const expectedSim = clicks.filter((c) =>
              (COGNITIVE_LOAD_STATES as readonly string[]).includes(c),
            );
            expect(onSimulate.mock.calls.map((c) => c[0])).toEqual(expectedSim);
            expect(onForceDeclutter).toHaveBeenCalledTimes(
              clicks.filter((c) => c === "Force declutter").length,
            );
            expect(onReset).toHaveBeenCalledTimes(clicks.filter((c) => c === "Reset UI").length);
          } finally {
            cleanup();
          }
        },
      ),
      { numRuns: 15 },
    );
  });
});
