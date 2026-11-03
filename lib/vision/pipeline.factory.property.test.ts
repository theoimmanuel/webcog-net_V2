// Feature: webcam-no-face-detection (bugfix spec)
//
// Task 4.3 — Property-based tests for the FIXED path: pipelines built with a
// `landmarkerFactory` (exactly how StudyProvider.getVisionPipeline() builds the
// Scenario C pipeline after the fix) rather than an explicit `landmarker`.
//
// The explicit-landmarker path is already covered by
// pipeline.preservation.test.ts (cases 1–4) and the privacy guard's payload
// classification by lib/privacy/network-guard.preservation.test.ts (the fix
// does not touch the guard), so neither is duplicated here. These properties
// assert the same preserved behaviors hold when the landmarker is resolved
// asynchronously from the factory inside start():
//
//   A. process() runs exactly on face frames (factory called exactly once,
//      regardless of how many microtasks it takes to resolve).
//   B. Sustained-loss fallback fires exactly once, only after
//      >= SUSTAINED_FACE_LOSS_MS of continuous no-face.
//   C. Webcam denial at random timings rejects start() once with a single
//      onError notification, and the factory is never called.
//
// **Validates: Requirements 3.1, 3.2, 3.4, 3.6**

import { describe, it, expect, vi } from "vitest";
import fc from "fast-check";
import {
  WebcamVisionPipeline,
  WebcamUnavailableError,
  SUSTAINED_FACE_LOSS_MS,
  type FaceLandmarker,
  type VisionPipelineOptions,
} from "@/lib/vision/pipeline";
import type { Classifier } from "@/lib/vision/classifier";
import {
  FeatureExtractor,
  LEFT_EYE_EAR_INDICES,
  RIGHT_EYE_EAR_INDICES,
  LEFT_EYE_CENTER_INDEX,
  RIGHT_EYE_CENTER_INDEX,
  type Landmark,
} from "@/lib/vision/features";

// Keep TF.js out of the suite; a fake classifier is injected below.
vi.mock("@/lib/vision/classifier", () => ({
  createClassifier: () => ({
    load: async () => {},
    predict: () => ({ state: "LOW" as const, latencyMs: 1 }),
    modelSizeBytes: () => 1024,
  }),
}));

// -----------------------------------------------------------------------------
// Helpers
// -----------------------------------------------------------------------------

/** FaceMesh-shaped landmark array representing a visible face. */
function faceLandmarks(openness = 0.4): Landmark[] {
  const lm: Landmark[] = Array.from({ length: 478 }, () => ({ x: 0.5, y: 0.5, z: 0 }));
  const placeEye = (
    idx: readonly [number, number, number, number, number, number],
    cx: number,
  ) => {
    const [p1, p2, p3, p4, p5, p6] = idx;
    const cy = 0.45;
    const w = 0.04;
    const h = w * openness;
    lm[p1] = { x: cx - w, y: cy, z: 0 };
    lm[p4] = { x: cx + w, y: cy, z: 0 };
    lm[p2] = { x: cx - w / 3, y: cy - h, z: 0 };
    lm[p3] = { x: cx + w / 3, y: cy - h, z: 0 };
    lm[p6] = { x: cx - w / 3, y: cy + h, z: 0 };
    lm[p5] = { x: cx + w / 3, y: cy + h, z: 0 };
  };
  placeEye(LEFT_EYE_EAR_INDICES, 0.4);
  placeEye(RIGHT_EYE_EAR_INDICES, 0.6);
  lm[LEFT_EYE_CENTER_INDEX] = { x: 0.4, y: 0.45, z: 0 };
  lm[RIGHT_EYE_CENTER_INDEX] = { x: 0.6, y: 0.45, z: 0 };
  return lm;
}

function fakeClassifier(): Classifier {
  return {
    load: async () => {},
    predict: () => ({ state: "LOW", latencyMs: 1 }),
    modelSizeBytes: () => 1024,
  } as unknown as Classifier;
}

/**
 * Deterministic harness for a factory-built pipeline: NO explicit
 * `landmarker`; the mock landmarker is only reachable via `landmarkerFactory`,
 * which resolves after `factoryTicks` microtasks.
 */
function makeFactoryHarness(opts: {
  faceAt: (call: number) => boolean;
  factoryTicks?: number;
  getUserMedia?: VisionPipelineOptions["getUserMedia"];
}) {
  const state = {
    now: 0,
    pending: new Map<number, (now: number) => void>(),
    nextHandle: 1,
    detectCalls: 0,
    requestFrameCalls: 0,
  };

  const landmarker: FaceLandmarker = {
    detect: vi.fn(() => {
      const face = opts.faceAt(state.detectCalls);
      state.detectCalls += 1;
      return face ? faceLandmarks() : [];
    }),
    close: () => {},
  };

  const landmarkerFactory = vi.fn(async () => {
    for (let i = 0; i < (opts.factoryTicks ?? 0); i++) await Promise.resolve();
    return landmarker;
  });

  const fe = new FeatureExtractor();
  const processSpy = vi.spyOn(fe, "process");
  const resetSpy = vi.spyOn(fe, "reset");

  const tracks = [{ stop: vi.fn() }];
  const stubStream = { getTracks: () => tracks } as unknown as MediaStream;
  const videoStub = {
    videoWidth: 0,
    videoHeight: 0,
    srcObject: null as unknown,
    muted: false,
    play: async () => {},
  } as unknown as HTMLVideoElement;
  const canvasStub = {
    width: 0,
    height: 0,
    getContext: () => null,
  } as unknown as HTMLCanvasElement;

  const fallbackSpy = vi.fn();

  const pipeline = new WebcamVisionPipeline({
    classifier: fakeClassifier(),
    landmarkerFactory,
    featureExtractor: fe,
    getUserMedia: opts.getUserMedia ?? (async () => stubStream),
    clock: () => state.now,
    requestFrame: (cb) => {
      state.requestFrameCalls += 1;
      const h = state.nextHandle++;
      state.pending.set(h, cb);
      return h;
    },
    cancelFrame: (h) => {
      state.pending.delete(h);
    },
    onFallbackToSimulated: fallbackSpy,
    videoElement: videoStub,
    canvas: canvasStub,
  });

  const driveFrame = (t: number) => {
    state.now = t;
    const due = [...state.pending.values()];
    state.pending.clear();
    for (const cb of due) cb(t);
  };

  return {
    pipeline,
    state,
    landmarker,
    landmarkerFactory,
    processSpy,
    resetSpy,
    fallbackSpy,
    driveFrame,
  };
}

/** Inter-frame spacing above the 15 fps throttle so every frame is processed. */
const frameDtArb = fc.integer({ min: 70, max: 150 });
/** Microtasks the factory takes to resolve (models async WASM/model load). */
const factoryTicksArb = fc.integer({ min: 0, max: 8 });

// -----------------------------------------------------------------------------
// A. Feature updates exactly on face frames (Req 3.6)
// -----------------------------------------------------------------------------

describe("Factory path (A): factory-resolved landmarker drives feature processing", () => {
  it("process() runs exactly on face frames and the factory is awaited once", async () => {
    await fc.assert(
      fc.asyncProperty(
        fc.array(fc.tuple(fc.boolean(), frameDtArb), { minLength: 1, maxLength: 60 }),
        factoryTicksArb,
        async (frames, factoryTicks) => {
          const h = makeFactoryHarness({
            faceAt: (i) => frames[i]?.[0] ?? false,
            factoryTicks,
          });
          await h.pipeline.start();
          try {
            // Factory resolved before the capture loop was scheduled.
            expect(h.landmarkerFactory).toHaveBeenCalledTimes(1);
            expect(h.state.requestFrameCalls).toBe(1);

            let t = 1000;
            const faceTimes: number[] = [];
            for (const [face, dt] of frames) {
              if (face) faceTimes.push(t);
              h.driveFrame(t);
              t += dt;
            }

            expect(h.state.detectCalls).toBe(frames.length);
            expect(h.processSpy).toHaveBeenCalledTimes(faceTimes.length);
            expect(h.processSpy.mock.calls.map((c) => c[1])).toEqual(faceTimes);
            // Never re-resolved per frame.
            expect(h.landmarkerFactory).toHaveBeenCalledTimes(1);
          } finally {
            h.pipeline.stop();
          }
        },
      ),
      { numRuns: 50 },
    );
  });
});

// -----------------------------------------------------------------------------
// B. Sustained-loss fallback only after >= SUSTAINED_FACE_LOSS_MS (Req 3.1)
// -----------------------------------------------------------------------------

describe("Factory path (B): sustained face loss falls back exactly once", () => {
  it("fires onFallbackToSimulated once, only after >= SUSTAINED_FACE_LOSS_MS continuous no-face", async () => {
    let firingRuns = 0;
    await fc.assert(
      fc.asyncProperty(
        // Random face/no-face stream built from alternating runs so that loss
        // episodes both shorter and longer than 5000 ms occur frequently.
        fc
          .array(
            fc.tuple(fc.boolean(), fc.integer({ min: 1, max: 80 }), frameDtArb),
            { minLength: 1, maxLength: 6 },
          )
          .map((runs) =>
            runs.flatMap(([face, len, dt]) =>
              Array.from({ length: len }, () => [face, dt] as [boolean, number]),
            ),
          ),
        factoryTicksArb,
        async (frames, factoryTicks) => {
          const h = makeFactoryHarness({
            faceAt: (i) => frames[i]?.[0] ?? false,
            factoryTicks,
          });
          await h.pipeline.start();
          try {
            // Independent reference model of the face-loss machine.
            let t = 1000;
            let lossStart: number | null = null;
            let armed = true;
            const expectedFires: number[] = [];
            const actualFires: number[] = [];
            const resetsAtFire: number[] = [];

            for (const [face, dt] of frames) {
              if (face) {
                lossStart = t;
                armed = true;
              } else if (lossStart === null) {
                lossStart = t;
              } else if (armed && t - lossStart >= SUSTAINED_FACE_LOSS_MS) {
                expectedFires.push(t);
                armed = false;
              }

              const before = h.fallbackSpy.mock.calls.length;
              h.driveFrame(t);
              if (h.fallbackSpy.mock.calls.length > before) {
                actualFires.push(t);
                resetsAtFire.push(h.resetSpy.mock.calls.length);
              }
              t += dt;
            }

            // Fires exactly when the model says: once per continuous loss
            // episode of >= 5000 ms, never earlier, never repeatedly.
            expect(actualFires).toEqual(expectedFires);
            if (expectedFires.length > 0) firingRuns += 1;
            // Retained features discarded on each fallback.
            resetsAtFire.forEach((n, i) => expect(n).toBe(i + 1));
          } finally {
            h.pipeline.stop();
          }
        },
      ),
      { numRuns: 60 },
    );
    // Guard against a vacuous property: the generator must actually produce
    // loss episodes long enough to trigger the fallback.
    expect(firingRuns).toBeGreaterThan(0);
  });
});

// -----------------------------------------------------------------------------
// C. Webcam denial at random timings (Req 3.2)
// -----------------------------------------------------------------------------

describe("Factory path (C): webcam denial rejects start() once and never calls the factory", () => {
  it("rejects with WebcamUnavailableError, notifies onError once, and skips the factory", async () => {
    await fc.assert(
      fc.asyncProperty(
        fc.integer({ min: 0, max: 10 }),
        fc.constantFrom("NotAllowedError", "NotFoundError", "NotReadableError", "wrapped"),
        factoryTicksArb,
        async (ticks, kind, factoryTicks) => {
          const cause =
            kind === "wrapped"
              ? new WebcamUnavailableError("already wrapped")
              : Object.assign(new Error(kind), { name: kind });
          const getUserMedia = vi.fn(async () => {
            for (let i = 0; i < ticks; i++) await Promise.resolve();
            throw cause;
          });
          const h = makeFactoryHarness({ faceAt: () => true, getUserMedia, factoryTicks });
          const onError = vi.fn();
          h.pipeline.onError(onError);

          let caught: unknown = null;
          try {
            await h.pipeline.start();
          } catch (err) {
            caught = err;
          }

          expect(caught).toBeInstanceOf(WebcamUnavailableError);
          if (kind === "wrapped") {
            expect(caught).toBe(cause);
          } else {
            expect((caught as WebcamUnavailableError).cause).toBe(cause);
          }
          expect(getUserMedia).toHaveBeenCalledTimes(1);
          expect(onError).toHaveBeenCalledTimes(1);
          expect(onError).toHaveBeenCalledWith(caught);
          expect(h.landmarkerFactory).not.toHaveBeenCalled();
          expect(h.state.requestFrameCalls).toBe(0);
        },
      ),
      { numRuns: 40 },
    );
  });
});
