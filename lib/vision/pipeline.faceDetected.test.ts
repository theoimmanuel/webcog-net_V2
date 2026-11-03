// Feature: webcam-no-face-detection (bugfix spec)
//
// Property 3: Face-Visibility Notification - pipeline side.
//
// For any frame stream, each sample emitted by WebcamVisionPipeline carries
// `faceDetected` equal to the face-seen result of the most recent PROCESSED
// frame before that emission (throttled frames leave it unchanged), so a change
// in face presence is reflected by the next emitted sample (within one ~1 s
// window). A restarted pipeline does not leak a stale `true`.
//
// **Validates: Requirements 2.7, 2.8, 2.9**

import { describe, it, expect, vi } from "vitest";
import fc from "fast-check";
import {
  WebcamVisionPipeline,
  MIN_FRAME_INTERVAL_MS,
  WINDOW_STEP_MS,
  type FaceLandmarker,
  type VisionPipelineOptions,
} from "@/lib/vision/pipeline";
import type { Classifier } from "@/lib/vision/classifier";
import {
  LEFT_EYE_EAR_INDICES,
  RIGHT_EYE_EAR_INDICES,
  LEFT_EYE_CENTER_INDEX,
  RIGHT_EYE_CENTER_INDEX,
  type Landmark,
} from "@/lib/vision/features";
import type { LoadSample } from "@/lib/load/source";

// Keep TF.js out of the suite; a fake classifier is injected anyway.
vi.mock("@/lib/vision/classifier", () => ({
  createClassifier: () => ({
    load: async () => {},
    predict: () => ({ state: "LOW" as const, latencyMs: 1 }),
    modelSizeBytes: () => 1024,
  }),
}));

// -----------------------------------------------------------------------------
// Harness (mirrors pipeline.preservation.test.ts)
// -----------------------------------------------------------------------------

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
 * Deterministic harness: manual frame scheduler, injected clock, stub
 * stream/video/canvas, and a mock landmarker whose face/no-face answer is
 * controlled per driven frame via `driveFrame(t, face)`.
 */
function makeHarness() {
  const state = {
    now: 0,
    currentFace: false,
    pending: new Map<number, (now: number) => void>(),
    nextHandle: 1,
  };

  const landmarker: FaceLandmarker = {
    detect: () => (state.currentFace ? faceLandmarks() : []),
    close: () => {},
  };

  const stubStream = { getTracks: () => [{ stop: () => {} }] } as unknown as MediaStream;
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

  const options: VisionPipelineOptions = {
    classifier: fakeClassifier(),
    landmarker,
    getUserMedia: async () => stubStream,
    clock: () => state.now,
    requestFrame: (cb) => {
      const h = state.nextHandle++;
      state.pending.set(h, cb);
      return h;
    },
    cancelFrame: (h) => {
      state.pending.delete(h);
    },
    videoElement: videoStub,
    canvas: canvasStub,
  };

  const pipeline = new WebcamVisionPipeline(options);
  const samples: LoadSample[] = [];
  pipeline.subscribe((s) => samples.push(s));

  const driveFrame = (t: number, face: boolean) => {
    state.now = t;
    state.currentFace = face;
    const due = [...state.pending.values()];
    state.pending.clear();
    for (const cb of due) cb(t);
  };

  return { pipeline, samples, driveFrame };
}

// -----------------------------------------------------------------------------
// Property 3 - faceDetected equals the most recent processed frame's result
// -----------------------------------------------------------------------------

describe("Property 3: each emitted webcam sample carries the latest processed frame's face result", () => {
  it("faceDetected equals the face-seen result of the most recent processed frame (throttled frames ignored)", async () => {
    await fc.assert(
      fc.asyncProperty(
        // dt can fall below the 15 fps throttle so some frames are skipped.
        fc.array(fc.tuple(fc.boolean(), fc.integer({ min: 10, max: 400 })), {
          minLength: 1,
          maxLength: 120,
        }),
        async (frames) => {
          const h = makeHarness();
          await h.pipeline.start();
          try {
            // Independent reference model of the throttle + latest face result.
            let lastProcessedT: number | null = null;
            let lastFace: boolean | null = null;
            let t = 1000;
            for (const [face, dt] of frames) {
              if (lastProcessedT === null || t - lastProcessedT >= MIN_FRAME_INTERVAL_MS) {
                lastProcessedT = t;
                lastFace = face;
              }
              const before = h.samples.length;
              h.driveFrame(t, face);
              const emitted = h.samples.slice(before);
              expect(emitted.length).toBeLessThanOrEqual(1);
              for (const s of emitted) {
                expect(s.simulated).toBe(false);
                expect(s.faceDetected).toBe(lastFace);
              }
              t += dt;
            }
          } finally {
            h.pipeline.stop();
          }
        },
      ),
      { numRuns: 80 },
    );
  });

  it("a presence change is reflected by the next emitted sample, within one ~1 s window", async () => {
    await fc.assert(
      fc.asyncProperty(
        fc.boolean(), // initial presence
        fc.integer({ min: 1, max: 40 }), // frames before the change
        fc.integer({ min: 70, max: 150 }), // frame spacing (all frames processed)
        async (initial, framesBefore, dt) => {
          const h = makeHarness();
          await h.pipeline.start();
          try {
            let t = 1000;
            for (let i = 0; i < framesBefore; i++) {
              h.driveFrame(t, initial);
              t += dt;
            }
            const changeT = t;
            const before = h.samples.length;
            // Keep the new presence long enough for at least one window tick.
            while (h.samples.length === before && t <= changeT + 3 * WINDOW_STEP_MS) {
              h.driveFrame(t, !initial);
              t += dt;
            }
            expect(h.samples.length).toBeGreaterThan(before);
            const next = h.samples[before];
            expect(next.faceDetected).toBe(!initial);
            // Emitted no later than one window step (+ one frame of jitter) after the change.
            expect(next.timestamp - changeT).toBeLessThanOrEqual(WINDOW_STEP_MS + dt);
          } finally {
            h.pipeline.stop();
          }
        },
      ),
      { numRuns: 60 },
    );
  });
});

describe("Property 3: start() after stop() resets the face-seen state", () => {
  it("the first sample of a new run reflects the new run's frames, not a stale true", async () => {
    const h = makeHarness();
    await h.pipeline.start();
    // Run 1: face visible until a sample with faceDetected: true is emitted.
    let t = 1000;
    while (h.samples.length === 0) {
      h.driveFrame(t, true);
      t += 100;
    }
    expect(h.samples.at(-1)!.faceDetected).toBe(true);
    h.pipeline.stop();

    // The reset itself: a fresh start clears lastFrameFaceSeen.
    await h.pipeline.start();
    expect(
      (h.pipeline as unknown as { lastFrameFaceSeen: boolean }).lastFrameFaceSeen,
    ).toBe(false);

    // Run 2: no face at all; the first sample of the new run must be false.
    const before = h.samples.length;
    t += 5000;
    while (h.samples.length === before) {
      h.driveFrame(t, false);
      t += 100;
    }
    expect(h.samples[before].faceDetected).toBe(false);
    h.pipeline.stop();
  });
});
