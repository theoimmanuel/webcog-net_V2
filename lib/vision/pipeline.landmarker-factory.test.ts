// Feature: webcam-no-face-detection (bugfix spec)
//
// Task 4.1: Unit tests for the async `landmarkerFactory` / await behavior in
// `WebcamVisionPipeline.start()`.
//
//   - start() awaits the factory (after getUserMedia + classifier.load) and sets
//     the landmarker BEFORE the first scheduleNext() / requestFrame call.
//   - A rejecting factory rejects start() with WebcamUnavailableError, notifies
//     onError listeners, and releases the opened stream (tracks stopped).
//   - An explicit injected landmarker short-circuits the factory.
//   - With neither landmarker nor factory, processFrame stays on the degraded
//     no-face path (detect / FeatureExtractor.process never called).
//
// **Validates: Requirements 2.1, 2.6, 3.6**

import { describe, it, expect, vi } from "vitest";
import {
  WebcamVisionPipeline,
  WebcamUnavailableError,
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

// The shipped classifier pulls in TF.js; stub the module so nothing loads it.
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
function faceLandmarks(): Landmark[] {
  const lm: Landmark[] = Array.from({ length: 478 }, () => ({ x: 0.5, y: 0.5, z: 0 }));
  const placeEye = (
    idx: readonly [number, number, number, number, number, number],
    cx: number,
  ) => {
    const [p1, p2, p3, p4, p5, p6] = idx;
    const cy = 0.45;
    const w = 0.04;
    const h = w * 0.4;
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

function makeMockLandmarker(order: string[]): FaceLandmarker & {
  detect: ReturnType<typeof vi.fn>;
} {
  return {
    detect: vi.fn(() => {
      order.push("detect");
      return faceLandmarks();
    }),
    close: () => {},
  };
}

/** Deterministic harness: manual scheduler, injected clock, stub media/video/canvas. */
function makeHarness(overrides: Partial<VisionPipelineOptions> = {}) {
  const state = {
    now: 0,
    pending: new Map<number, (now: number) => void>(),
    nextHandle: 1,
    order: [] as string[],
  };

  const classifier = {
    load: vi.fn(async () => {
      state.order.push("classifier.load");
    }),
    predict: () => ({ state: "LOW", latencyMs: 1 }),
    modelSizeBytes: () => 1024,
  } as unknown as Classifier & { load: ReturnType<typeof vi.fn> };

  const fe = new FeatureExtractor();
  const processSpy = vi.spyOn(fe, "process");

  const tracks = [{ stop: vi.fn() }, { stop: vi.fn() }];
  const stubStream = { getTracks: () => tracks } as unknown as MediaStream;
  const getUserMedia = vi.fn(async () => {
    state.order.push("getUserMedia");
    return stubStream;
  });

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

  const requestFrame = vi.fn((cb: (now: number) => void) => {
    state.order.push("requestFrame");
    const h = state.nextHandle++;
    state.pending.set(h, cb);
    return h;
  });

  const options: VisionPipelineOptions = {
    classifier,
    featureExtractor: fe,
    getUserMedia,
    clock: () => state.now,
    requestFrame,
    cancelFrame: (h: number) => {
      state.pending.delete(h);
    },
    videoElement: videoStub,
    canvas: canvasStub,
    ...overrides,
  };

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
    classifier,
    processSpy,
    tracks,
    stubStream,
    videoStub,
    getUserMedia,
    requestFrame,
    driveFrame,
  };
}

function deferred<T>() {
  let resolve!: (v: T) => void;
  let reject!: (e: unknown) => void;
  const promise = new Promise<T>((res, rej) => {
    resolve = res;
    reject = rej;
  });
  return { promise, resolve, reject };
}

/** Flush pending microtasks so start() advances as far as it can. */
async function flushMicrotasks(n = 20) {
  for (let i = 0; i < n; i++) await Promise.resolve();
}

// -----------------------------------------------------------------------------
// Tests
// -----------------------------------------------------------------------------

describe("WebcamVisionPipeline landmarkerFactory", () => {
  it("awaits the factory after getUserMedia + classifier.load and sets the landmarker before the first scheduleNext()", async () => {
    const order: string[] = [];
    const landmarker = makeMockLandmarker(order);
    const gate = deferred<FaceLandmarker>();
    const factory = vi.fn(() => {
      order.push("factory");
      return gate.promise;
    });

    const h = makeHarness({ landmarkerFactory: factory });
    // Share one order log between harness and landmarker.
    h.state.order = order;

    const started = h.pipeline.start();
    await flushMicrotasks();

    // Factory is pending: called once, after media + classifier, no loop yet.
    expect(factory).toHaveBeenCalledTimes(1);
    expect(order).toEqual(["getUserMedia", "classifier.load", "factory"]);
    expect(h.requestFrame).not.toHaveBeenCalled();
    expect((h.pipeline as unknown as { landmarker: unknown }).landmarker).toBeNull();

    gate.resolve(landmarker);
    await started;

    // Landmarker assigned, then the capture loop was scheduled exactly once.
    expect((h.pipeline as unknown as { landmarker: unknown }).landmarker).toBe(landmarker);
    expect(h.requestFrame).toHaveBeenCalledTimes(1);
    expect(order).toEqual(["getUserMedia", "classifier.load", "factory", "requestFrame"]);

    // The first frame runs on the resolved landmarker and processes features.
    h.driveFrame(1000);
    expect(landmarker.detect).toHaveBeenCalledTimes(1);
    expect(h.processSpy).toHaveBeenCalledTimes(1);

    h.pipeline.stop();
  });

  it("rejects start() with WebcamUnavailableError, notifies onError, and releases the stream when the factory rejects", async () => {
    const cause = new Error("wasm fetch failed");
    const factory = vi.fn(async () => {
      throw cause;
    });
    const h = makeHarness({ landmarkerFactory: factory });
    const onError = vi.fn();
    h.pipeline.onError(onError);

    let caught: unknown = null;
    try {
      await h.pipeline.start();
    } catch (err) {
      caught = err;
    }

    expect(caught).toBeInstanceOf(WebcamUnavailableError);
    expect((caught as WebcamUnavailableError).cause).toBe(cause);
    expect(onError).toHaveBeenCalledTimes(1);
    expect(onError).toHaveBeenCalledWith(caught);

    // Stream was opened, then every track was stopped and the reference dropped.
    expect(h.getUserMedia).toHaveBeenCalledTimes(1);
    for (const track of h.tracks) expect(track.stop).toHaveBeenCalledTimes(1);
    expect((h.pipeline as unknown as { stream: unknown }).stream).toBeNull();
    expect(h.videoStub.srcObject).toBeNull();

    // No capture loop started; landmarker remains unset.
    expect(h.requestFrame).not.toHaveBeenCalled();
    expect((h.pipeline as unknown as { landmarker: unknown }).landmarker).toBeNull();
  });

  it("short-circuits the factory when an explicit landmarker is injected", async () => {
    const order: string[] = [];
    const explicit = makeMockLandmarker(order);
    const factory = vi.fn(async () => makeMockLandmarker(order));
    const h = makeHarness({ landmarker: explicit, landmarkerFactory: factory });

    await h.pipeline.start();
    h.driveFrame(1000);

    expect(factory).not.toHaveBeenCalled();
    expect((h.pipeline as unknown as { landmarker: unknown }).landmarker).toBe(explicit);
    expect(explicit.detect).toHaveBeenCalledTimes(1);
    expect(h.processSpy).toHaveBeenCalledTimes(1);

    h.pipeline.stop();
  });

  it("keeps the degraded no-face path when neither a landmarker nor a factory is available", async () => {
    const h = makeHarness();
    await h.pipeline.start();

    const processFrame = (
      h.pipeline as unknown as { processFrame: (t: number) => boolean }
    ).processFrame.bind(h.pipeline);
    expect(processFrame(500)).toBe(false);

    // Drive several frames through the real loop as well.
    for (let i = 0; i < 10; i++) h.driveFrame(1000 + i * 100);

    expect((h.pipeline as unknown as { landmarker: unknown }).landmarker).toBeNull();
    expect(h.processSpy).not.toHaveBeenCalled();
    const latest = h.pipeline.latest();
    // Any sample emitted reports no face detected.
    if (latest) expect(latest.faceDetected).toBe(false);

    h.pipeline.stop();
  });
});
