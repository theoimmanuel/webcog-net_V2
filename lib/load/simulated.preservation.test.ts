// Feature: webcam-no-face-detection (bugfix spec)
//
// Property 2: Preservation - simulated samples carry no face field (Req 3.7).
//
// Observed on UNFIXED code: every sample the SimulatedLoadTrigger emits has
// exactly the fields state/ear/blinkRate/saccadeVelocity/latencyMs/timestamp/
// degraded/simulated, with `simulated: true`, `degraded: false`, and no
// `faceDetected` field. The face-visibility enhancement must not change this.
//
// **Validates: Requirements 3.7**

import { describe, it, expect } from "vitest";
import fc from "fast-check";
import { createSimulatedTrigger, synthesizeMetrics } from "@/lib/load/simulated";
import { COGNITIVE_LOAD_STATES, type LoadSample } from "@/lib/load/source";

const SAMPLE_KEYS = [
  "blinkRate",
  "degraded",
  "ear",
  "latencyMs",
  "saccadeVelocity",
  "simulated",
  "state",
  "timestamp",
];

const LOAD_PERCENT = { LOW: 20, MODERATE: 50, HIGH: 85 } as const;

describe("Property 2 (case 7): simulated samples are unchanged and carry no faceDetected", () => {
  it("every emitted sample has simulated: true, faceDetected undefined, and unchanged fields", async () => {
    await fc.assert(
      fc.asyncProperty(
        fc.constantFrom(...COGNITIVE_LOAD_STATES),
        fc.array(fc.constantFrom(...COGNITIVE_LOAD_STATES), { maxLength: 20 }),
        fc.array(fc.double({ min: 0, max: 0.999999, noNaN: true }), { minLength: 1, maxLength: 16 }),
        fc.integer({ min: 0, max: 1_000_000 }),
        async (initialState, levels, randoms, t0) => {
          let r = 0;
          const random = () => randoms[r++ % randoms.length];
          let now = t0;
          const clock = () => now++;
          const trigger = createSimulatedTrigger({ initialState, random, clock });

          const samples: LoadSample[] = [];
          trigger.subscribe((s) => samples.push(s));
          await trigger.start();
          for (const level of levels) trigger.set(level);
          trigger.stop();

          const expectedStates = [initialState, ...levels];
          expect(samples.map((s) => s.state)).toEqual(expectedStates);

          // Replay the RNG to recompute the expected synthesised metrics.
          let rr = 0;
          const replay = () => randoms[rr++ % randoms.length];
          samples.forEach((s, i) => {
            expect(Object.keys(s).sort()).toEqual(SAMPLE_KEYS);
            expect(s.simulated).toBe(true);
            expect(s.degraded).toBe(false);
            expect((s as LoadSample & { faceDetected?: boolean }).faceDetected).toBeUndefined();
            expect("faceDetected" in s).toBe(false);
            expect(s.timestamp).toBe(t0 + i);
            const m = synthesizeMetrics(LOAD_PERCENT[expectedStates[i]], replay);
            expect(s.ear).toBe(m.ear);
            expect(s.blinkRate).toBe(m.blinkRate);
            expect(s.saccadeVelocity).toBe(m.saccadeVelocity);
            expect(s.latencyMs).toBe(m.latencyMs);
          });
        },
      ),
      { numRuns: 100 },
    );
  });
});
