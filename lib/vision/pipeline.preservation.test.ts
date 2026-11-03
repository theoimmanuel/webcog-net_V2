// Feature: webcam-no-face-detection (bugfix spec)
//
// Property 2: Preservation - Non-bug-condition inputs behave identically
// (F(X) = F'(X)) — pipeline-level preserved cases.
//
// These tests were written observation-first against the UNFIXED pipeline and
// MUST keep passing after the fix. They cover the inputs that do NOT satisfy
// the bug condition (an explicit mock landmarker is injected, or getUserMedia
// rejects):
//
//   1. Injected mock landmarker precedence (Req 3.6): FeatureExtractor.process()
//      runs exactly on face frames; a landmarkerFactory spy supplied alongside
//      an explicit landmarker is never consulted.
//   2. Genuine sustained face loss (Req 3.1): retained features are discarded
//      and onFallbackToSimulated fires exactly once, only after >= 5000 ms of
//      continuous no-face.
//   3. Webcam denial (Req 3.2): a rejecting getUserMedia makes start() reject
//      with WebcamUnavailableError and notifies onError exactly once.
//   4. Immediate frame-pixel release (Req 3.3): every processed frame clears
//      the canvas after detection and no frame/snapshot reference survives.
//
// **Validates: Requirements 3.1, 3.2, 3.3, 3.6**

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

// The shipped classifier pulls in TF.js; these tests inject a fake classifier,
// so stub the module to keep the suite fast and network-free.
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

/** Build a FaceMesh-shaped landmark array representing a visible face. */
function faceLandmarks(openness: number, gazeX = 0, gazeY = 0): Landmark[] {
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

function fakeClassifier(): Classifier {
  return {
    load: async () => {},
    predict: () => ({ state: "LOW", latencyMs: 1 }),
    modelSizeBytes: () => 1024,
  } as unknown as Classifier;
}

interface CanvasCtxSpy {
  drawImage: ReturnType<typeof vi.fn>;
  clearRect: ReturnType<typeof vi.fn>;
  getImageData: ReturnType<typeof vi.fn>;
}

/**
 * A deterministic pipeline harness: manual frame scheduler, injected clock,
 * stub stream/video/canvas, real FeatureExtractor with a `process` spy.
 */
function makeHarness(opts: {
  /** Per-detect-call face flag; index = detect call number. */
  faceAt: (call: number) => boolean;
  getUserMedia?: VisionPipelineOptions["getUserMedia"];
  withCanvas?: boolean;
  onFallback?: () => void;
}) {
  const state = {
    now: 0,
    pending: new Map<number, (now: number) => void>(),
    nextHandle: 1,
    detectCalls: 0,
    requestFrameCalls: 0,
    order: [] as string[],
  };

  const landmarker: FaceLandmarker = {
    detect: vi.fn(() => {
      const face = opts.faceAt(state.detectCalls);
      state.detectCalls += 1;
      state.order.push("detect");
      return face ? faceLandmarks(0.4) : [];
    }),
    close: () => {},
  };

  const fe = new FeatureExtractor();
  const processSpy = vi.spyOn(fe, "process");
  const resetSpy = vi.spyOn(fe, "reset");

  const ctx: CanvasCtxSpy = {
    drawImage: vi.fn(() => state.order.push("draw")),
    clearRect: vi.fn(() => state.order.push("clear")),
    getImageData: vi.fn(),
  };

  const tracks = [{ stop: vi.fn() }];
  const stubStream = { getTracks: () => tracks } as unknown as MediaStream;

  const videoStub = {
    videoWidth: opts.withCanvas ? 64 : 0,
    videoHeight: opts.withCanvas ? 48 : 0,
    srcObject: null as unknown,
    muted: false,
    play: async () => {},
  } as unknown as HTMLVideoElement;

  const canvasStub = {
    width: 0,
    height: 0,
    getContext: () => (opts.withCanvas ? ctx : null),
  } as unknown as HTMLCanvasElement;

  const fallbackSpy = vi.fn(() => opts.onFallback?.());
  const landmarkerFactorySpy = vi.fn(async () => landmarker);

  const options = {
    classifier: fakeClassifier(),
    landmarker,
    // Supplied via an untyped cast so this compiles before the fix adds the
    // field. With an explicit landmarker it must never be consulted.
    landmarkerFactory: landmarkerFactorySpy,
    featureExtractor: fe,
    getUserMedia: opts.getUserMedia ?? (async () => stubStream),
    clock: () => state.now,
    requestFrame: (cb: (now: number) => void) => {
      state.requestFrameCalls += 1;
      const h = state.nextHandle++;
      state.pending.set(h, cb);
      return h;
    },
    cancelFrame: (h: number) => {
      state.pending.delete(h);
    },
    onFallbackToSimulated: fallbackSpy,
    videoElement: videoStub,
    canvas: canvasStub,
  } as unknown as VisionPipelineOptions;

  const pipeline = new WebcamVisionPipeline(options);

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
    processSpy,
    resetSpy,
    fallbackSpy,
    landmarkerFactorySpy,
    ctx,
    tracks,
    driveFrame,
  };
}

/** Inter-frame spacing above the 15 fps throttle so every frame is processed. */
const frameDtArb = fc.integer({ min: 70, max: 150 });

// -----------------------------------------------------------------------------
// Preserved case 1 - injected mock landmarker precedence (Req 3.6)
// -----------------------------------------------------------------------------

describe("Property 2 (case 1): injected mock landmarker drives feature processing deterministically", () => {
  it("FeatureExtractor.process() is invoked exactly on face frames; the factory is never consulted", async () => {
    await fc.assert(
      fc.asyncProperty(
        fc.array(fc.tuple(fc.boolean(), frameDtArb), { minLength: 1, maxLength: 60 }),
        async (frames) => {
          const h = makeHarness({ faceAt: (i) => frames[i]?.[0] ?? false });
          await h.pipeline.start();
          try {
            let t = 1000;
            const faceTimes: number[] = [];
            for (const [face, dt] of frames) {
              if (face) faceTimes.push(t);
              h.driveFrame(t);
              t += dt;
            }
            // Every driven frame reached the injected landmarker.
            expect(h.state.detectCalls).toBe(frames.length);
            // process() ran exactly on face frames, at those frames' timestamps.
            expect(h.processSpy).toHaveBeenCalledTimes(faceTimes.length);
            expect(h.processSpy.mock.calls.map((c) => c[1])).toEqual(faceTimes);
            // An explicit landmarker wins: the factory is never called.
            expect(h.landmarkerFactorySpy).not.toHaveBeenCalled();
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
// Preserved case 2 - genuine sustained face loss (Req 3.1)
// -----------------------------------------------------------------------------

describe("Property 2 (case 2): genuine sustained face loss falls back exactly once", () => {
  it("fires onFallbackToSimulated once, only after >= SUSTAINED_FACE_LOSS_MS continuous no-face, discarding retained features", async () => {
    await fc.assert(
      fc.asyncProperty(
        fc.integer({ min: 0, max: 20 }), // face frames before the loss
        frameDtArb,
        fc.integer({ min: 0, max: 9000 }), // generated loss duration (ms)
        async (faceFrames, dt, lossMs) => {
          const totalNoFace = Math.ceil(lossMs / dt) + 1;
          const isFace = (i: number) => i < faceFrames;

          let historyAtFallback = -1;
          let resetCallsAtFallback = -1;
          const h = makeHarness({
            faceAt: isFace,
            onFallback: () => {
              historyAtFallback = (
                h.pipeline as unknown as { windowHistory: unknown[] }
              ).windowHistory.length;
              resetCallsAtFallback = h.resetSpy.mock.calls.length;
            },
          });
          await h.pipeline.start();
          try {
            // Independent reference: loss is anchored at the last face frame,
            // or at the first frame when no face was ever seen.
            let t = 1000;
            let lossStart: number | null = null;
            let expectedFireT: number | null = null;
            let fireT: number | null = null;
            for (let i = 0; i < faceFrames + totalNoFace; i++) {
              if (isFace(i)) {
                lossStart = t;
              } else if (lossStart === null) {
                lossStart = t;
              } else if (expectedFireT === null && t - lossStart >= SUSTAINED_FACE_LOSS_MS) {
                expectedFireT = t;
              }
              const before = h.fallbackSpy.mock.calls.length;
              h.driveFrame(t);
              if (fireT === null && h.fallbackSpy.mock.calls.length > before) fireT = t;
              t += dt;
            }

            if (expectedFireT === null) {
              expect(h.fallbackSpy).not.toHaveBeenCalled();
            } else {
              expect(h.fallbackSpy).toHaveBeenCalledTimes(1);
              expect(fireT).toBe(expectedFireT);
              expect(fireT! - (lossStart as number)).toBeGreaterThanOrEqual(
                SUSTAINED_FACE_LOSS_MS,
              );
              // Retained aggregated features discarded before the fallback.
              expect(historyAtFallback).toBe(0);
              expect(resetCallsAtFallback).toBe(1);
            }
          } finally {
            h.pipeline.stop();
          }
        },
      ),
      { numRuns: 60 },
    );
  });
});

// -----------------------------------------------------------------------------
// Preserved case 3 - webcam denial (Req 3.2)
// -----------------------------------------------------------------------------

describe("Property 2 (case 3): webcam denial rejects start() and notifies onError once", () => {
  it("rejects with WebcamUnavailableError and emits a single error notification for any denial timing", async () => {
    await fc.assert(
      fc.asyncProperty(
        fc.integer({ min: 0, max: 10 }), // microtask ticks before the denial
        fc.constantFrom("NotAllowedError", "NotFoundError", "NotReadableError", "wrapped"),
        async (ticks, kind) => {
          const cause =
            kind === "wrapped"
              ? new WebcamUnavailableError("already wrapped")
              : Object.assign(new Error(kind), { name: kind });
          const getUserMedia = vi.fn(async () => {
            for (let i = 0; i < ticks; i++) await Promise.resolve();
            throw cause;
          });
          const h = makeHarness({ faceAt: () => true, getUserMedia });
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
          expect(onError).toHaveBeenCalledTimes(1);
          expect(onError).toHaveBeenCalledWith(caught);
          // No capture loop was started and the factory was never consulted.
          expect(h.state.requestFrameCalls).toBe(0);
          expect(h.landmarkerFactorySpy).not.toHaveBeenCalled();
        },
      ),
      { numRuns: 40 },
    );
  });
});

// -----------------------------------------------------------------------------
// Preserved case 4 - immediate frame-pixel release (Req 3.3)
// -----------------------------------------------------------------------------

describe("Property 2 (case 4): every processed frame releases its pixels immediately", () => {
  it("clears the canvas after each detection and retains no frame/snapshot reference", async () => {
    await fc.assert(
      fc.asyncProperty(
        fc.array(fc.tuple(fc.boolean(), frameDtArb), { minLength: 1, maxLength: 40 }),
        async (frames) => {
          const h = makeHarness({
            faceAt: (i) => frames[i]?.[0] ?? false,
            withCanvas: true,
          });
          await h.pipeline.start();
          try {
            let t = 1000;
            for (const [, dt] of frames) {
              h.driveFrame(t);
              t += dt;
            }
            // draw -> detect -> clear for every processed frame, in that order.
            const expectedOrder = frames.flatMap(() => ["draw", "detect", "clear"]);
            expect(h.state.order).toEqual(expectedOrder);
            for (const call of h.ctx.clearRect.mock.calls) {
              expect(call).toEqual([0, 0, 64, 48]);
            }
            // Pixels are never read back into a snapshot.
            expect(h.ctx.getImageData).not.toHaveBeenCalled();
            // No pipeline field references a frame snapshot / derived image.
            for (const value of Object.values(h.pipeline as object)) {
              if (value === null || typeof value !== "object") continue;
              const name = (value as object).constructor?.name;
              expect(["ImageData", "ImageBitmap", "VideoFrame", "Blob"]).not.toContain(name);
              expect(value).not.toBe(h.ctx);
            }
          } finally {
            h.pipeline.stop();
          }
        },
      ),
      { numRuns: 40 },
    );
  });
});
