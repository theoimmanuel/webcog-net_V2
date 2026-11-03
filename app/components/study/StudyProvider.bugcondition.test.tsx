// Feature: webcam-no-face-detection (bugfix spec)
//
// Property 1: Bug Condition - Null landmarker forces no-face path and spurious
// fallback.
//
// Bug-condition exploration test. It builds the Scenario C webcam pipeline
// EXACTLY the way the app does — through `StudyProvider.getVisionPipeline()` —
// and only swaps in deterministic test seams (fake getUserMedia resolving a
// stub MediaStream, a manual requestFrame/cancelFrame scheduler, a
// deterministic clock, a FeatureExtractor spy, a fake classifier, and a mocked
// `createMediaPipeFaceLandmarker` returning a landmarker that always sees a
// face). The app's own pipeline options (classifier, onFallbackToSimulated,
// and — after the fix — landmarkerFactory) are passed through untouched.
//
// The assertions encode the EXPECTED (fixed) behavior:
//   A. face-present frames feed FeatureExtractor.process();
//   B. a continuously present face never triggers the sustained-face-loss
//      fallback to the Simulated_Trigger;
//   C. start() consults the landmarker factory (createMediaPipeFaceLandmarker).
//
// On UNFIXED code getVisionPipeline() injects no landmarker and no factory, so
// this test is EXPECTED TO FAIL — that failure confirms the bug exists.
//
// **Validates: Requirements 1.1, 1.2, 1.3, 1.4, 1.5**

import { describe, it, expect, vi, afterEach } from "vitest";
import { render, waitFor, cleanup, act } from "@testing-library/react";
import fc from "fast-check";
import type {
  VisionPipelineOptions,
  WebcamVisionPipeline,
} from "@/lib/vision/pipeline";
import { SUSTAINED_FACE_LOSS_MS } from "@/lib/vision/pipeline";
import type { Landmark } from "@/lib/vision/features";
import {
  LEFT_EYE_EAR_INDICES,
  RIGHT_EYE_EAR_INDICES,
  LEFT_EYE_CENTER_INDEX,
  RIGHT_EYE_CENTER_INDEX,
} from "@/lib/vision/features";
import { StudyProvider, useStudy, type StudyContextValue } from "./StudyProvider";

// -----------------------------------------------------------------------------
// Shared, hoisted harness state (read by the module mocks below)
// -----------------------------------------------------------------------------

type FrameCb = (now: number) => void;

const harness = vi.hoisted(() => {
  const state = {
    now: 0,
    pending: new Map<number, (now: number) => void>(),
    nextHandle: 1,
    /** Landmark stream the mocked MediaPipe landmarker replays (face present). */
    faceStream: [] as { x: number; y: number; z?: number }[][],
    detectCalls: 0,
    /** Options the app passed into createVisionPipeline (captured). */
    appOptions: null as Record<string, unknown> | null,
    featureExtractor: null as unknown,
    processSpy: null as unknown,
    fallbackSpy: null as unknown,
    landmarkerFactorySpy: null as unknown,
  };
  return state;
});

// The app's classifier is the shipped TF.js model; replace it with a fake so no
// network/model is required. Pipeline + StudyProvider both import from here.
vi.mock("@/lib/vision/classifier", () => {
  const makeFake = () => ({
    load: async () => {},
    predict: () => ({ state: "LOW" as const, latencyMs: 1 }),
    modelSizeBytes: () => 1024,
  });
  return { createClassifier: () => makeFake() };
});

// Wrap the real pipeline module: the app's options are forwarded verbatim, and
// only the deterministic test seams are added. `createMediaPipeFaceLandmarker`
// is replaced by a spy resolving a mock landmarker that always detects a face.
vi.mock("@/lib/vision/pipeline", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/lib/vision/pipeline")>();
  const { FeatureExtractor: RealFeatureExtractor } = await import("@/lib/vision/features");

  const mockLandmarker = {
    detect: () => {
      const stream = harness.faceStream;
      const lm = stream[harness.detectCalls % Math.max(1, stream.length)] ?? [];
      harness.detectCalls += 1;
      return lm;
    },
    close: () => {},
  };

  const landmarkerFactorySpy = vi.fn(async () => mockLandmarker);
  harness.landmarkerFactorySpy = landmarkerFactorySpy;

  const createVisionPipeline = vi.fn((appOptions: VisionPipelineOptions = {}) => {
    harness.appOptions = { ...appOptions } as Record<string, unknown>;

    const fe = new RealFeatureExtractor();
    const processSpy = vi.spyOn(fe, "process");
    harness.featureExtractor = fe;
    harness.processSpy = processSpy;

    const appFallback = appOptions.onFallbackToSimulated;
    const fallbackSpy = vi.fn(() => appFallback?.());
    harness.fallbackSpy = fallbackSpy;

    const stubStream = {
      getTracks: () => [{ stop: () => {} }],
    } as unknown as MediaStream;

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

    const seams: VisionPipelineOptions = {
      getUserMedia: async () => stubStream,
      clock: () => harness.now,
      requestFrame: (cb: FrameCb) => {
        const h = harness.nextHandle++;
        harness.pending.set(h, cb);
        return h;
      },
      cancelFrame: (h: number) => {
        harness.pending.delete(h);
      },
      featureExtractor: fe,
      videoElement: videoStub,
      canvas: canvasStub,
    };

    // App options win for everything the app decides (classifier, landmarker,
    // landmarkerFactory...). Only the fallback is wrapped to observe it.
    return new actual.WebcamVisionPipeline({
      ...seams,
      ...appOptions,
      onFallbackToSimulated: fallbackSpy,
    });
  });

  return {
    ...actual,
    createVisionPipeline,
    createMediaPipeFaceLandmarker: landmarkerFactorySpy,
  };
});

// -----------------------------------------------------------------------------
// Helpers
// -----------------------------------------------------------------------------

/** Build a FaceMesh-shaped landmark array representing a visible face. */
function faceLandmarks(openness: number, gazeX: number, gazeY: number): Landmark[] {
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
  lm[LEFT_EYE_CENTER_INDEX] = { x: 0.4 + gazeX, y: 0.45 + gazeY, z: 0 };
  lm[RIGHT_EYE_CENTER_INDEX] = { x: 0.6 + gazeX, y: 0.45 + gazeY, z: 0 };
  return lm;
}

/** Generated stream of face-present frames (blinks + gaze shifts). */
const faceFrameArb = fc
  .record({
    openness: fc.double({ min: 0.05, max: 0.6, noNaN: true }),
    gazeX: fc.double({ min: -0.01, max: 0.01, noNaN: true }),
    gazeY: fc.double({ min: -0.01, max: 0.01, noNaN: true }),
  })
  .map(({ openness, gazeX, gazeY }) => faceLandmarks(openness, gazeX, gazeY));

/** Inter-frame spacing above the 15 fps throttle so every frame is processed. */
const frameDtArb = fc.integer({ min: 70, max: 120 });

function resetHarness(faceStream: Landmark[][]): void {
  harness.now = 0;
  harness.pending.clear();
  harness.nextHandle = 1;
  harness.faceStream = faceStream;
  harness.detectCalls = 0;
  harness.appOptions = null;
  harness.featureExtractor = null;
  harness.processSpy = null;
  harness.fallbackSpy = null;
  (harness.landmarkerFactorySpy as ReturnType<typeof vi.fn>).mockClear();
}

/** Drive the pending frame callback(s) at time `t`. */
function driveFrame(t: number): void {
  harness.now = t;
  const due = [...harness.pending.entries()];
  harness.pending.clear();
  for (const [, cb] of due) cb(t);
}

/** Render the real StudyProvider and return the app-built Scenario C pipeline. */
async function buildAppPipeline(): Promise<WebcamVisionPipeline> {
  let ctx: StudyContextValue | null = null;
  function Probe() {
    ctx = useStudy();
    return null;
  }
  render(
    <StudyProvider>
      <Probe />
    </StudyProvider>,
  );
  await waitFor(() => expect(ctx?.ready).toBe(true));
  const pipeline = (ctx as unknown as StudyContextValue).getVisionPipeline();
  expect(pipeline).not.toBeNull();
  return pipeline as WebcamVisionPipeline;
}

/** Start the pipeline as the Scenario C effect does, then drive face frames. */
async function runFaceStream(
  pipeline: WebcamVisionPipeline,
  dts: number[],
): Promise<{ framesDriven: number }> {
  await act(async () => {
    await pipeline.start();
  });
  let t = 1000;
  let framesDriven = 0;
  for (const dt of dts) {
    driveFrame(t);
    framesDriven += 1;
    t += dt;
  }
  return { framesDriven };
}

afterEach(() => {
  cleanup();
});

// -----------------------------------------------------------------------------
// Property 1: Bug Condition
// -----------------------------------------------------------------------------

describe("Property 1: Bug Condition - Null landmarker forces no-face path and spurious fallback", () => {
  it("A: face-present frames are fed to FeatureExtractor.process()", async () => {
    await fc.assert(
      fc.asyncProperty(
        fc.array(faceFrameArb, { minLength: 3, maxLength: 8 }),
        fc.array(frameDtArb, { minLength: 5, maxLength: 20 }),
        async (stream, dts) => {
          resetHarness(stream);
          const pipeline = await buildAppPipeline();
          try {
            const { framesDriven } = await runFaceStream(pipeline, dts);
            const processSpy = harness.processSpy as ReturnType<typeof vi.fn>;
            // Expected: every face-present frame is processed into features.
            expect(processSpy).toHaveBeenCalledTimes(framesDriven);
          } finally {
            pipeline.stop();
            cleanup();
          }
        },
      ),
      { numRuns: 10 },
    );
  });

  it("B: a continuously present face never triggers the sustained-face-loss fallback", async () => {
    await fc.assert(
      fc.asyncProperty(
        fc.array(faceFrameArb, { minLength: 3, maxLength: 8 }),
        frameDtArb,
        fc.integer({ min: 500, max: 2000 }),
        async (stream, dt, extraMs) => {
          resetHarness(stream);
          const pipeline = await buildAppPipeline();
          try {
            // Enough frames to span well past SUSTAINED_FACE_LOSS_MS.
            const n = Math.ceil((SUSTAINED_FACE_LOSS_MS + extraMs) / dt) + 1;
            await runFaceStream(pipeline, Array.from({ length: n }, () => dt));
            const fallbackSpy = harness.fallbackSpy as ReturnType<typeof vi.fn>;
            // Expected: no spurious fallback while a face is present.
            expect(fallbackSpy).not.toHaveBeenCalled();
          } finally {
            pipeline.stop();
            cleanup();
          }
        },
      ),
      { numRuns: 10 },
    );
  });

  it("C: start() consults the MediaPipe landmarker factory", async () => {
    resetHarness([faceLandmarks(0.4, 0, 0)]);
    const pipeline = await buildAppPipeline();
    try {
      await act(async () => {
        await pipeline.start();
      });
      const factorySpy = harness.landmarkerFactorySpy as ReturnType<typeof vi.fn>;
      // Expected: the app wires an async landmarker factory into the pipeline...
      expect(typeof harness.appOptions?.landmarkerFactory).toBe("function");
      // ...and start() awaits it, which calls createMediaPipeFaceLandmarker().
      expect(factorySpy).toHaveBeenCalledTimes(1);
    } finally {
      pipeline.stop();
    }
  });
});
