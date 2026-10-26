"use client";

// Feature: webcog-net-site
//
// Vision_Pipeline cognitive-load source (Req 3). A `CognitiveLoadSource` of
// kind "webcam" that:
//
//   1. opens the webcam via `getUserMedia({ video: true })` — ONLY after the
//      caller has gated it on consent (Req 2.1, 2.3); this module never
//      requests media on its own before `start()` is called;
//   2. runs a capture loop targeting >= 15 fps (Req 3.1) using
//      `requestVideoFrameCallback` when available, else `requestAnimationFrame`;
//   3. for each frame: draws it to an offscreen canvas, runs a FaceMesh
//      landmarker to obtain landmarks, feeds landmarks -> features.ts ->
//      aggregator, then releases the frame reference and clears the canvas
//      within 100 ms, holding NO frame / canvas snapshot / derived-image
//      reference afterwards and never persisting a frame (Req 2.6, Property 5);
//   4. on each 1-second window tick advances the aggregator and runs the
//      Classifier to produce a `LoadSample` (simulated: false) and emits it;
//   5. on a frame with no detected face reuses the prior aggregated features
//      for that window slot and marks `degraded: true` (Req 3.5, Property 9) —
//      this is realised by the aggregator's own degraded-slot behaviour (it
//      reuses prior features for a slot that received no fresh frames);
//   6. on no face for >= 5 continuous seconds discards the retained aggregated
//      features and asks the LoadSourceController to fall back to the
//      Simulated_Trigger (Req 3.6, Property 10);
//   7. surfaces webcam denial/unavailability by rejecting `start()` and (when a
//      listener is attached) emitting an error, so the harness can either end
//      the study (Req 2.7) or fall back to simulated and inform the participant
//      (Req 3.7).
//
// Privacy (Req 2.6, Property 5): a frame's pixels are only ever read inside the
// synchronous landmark-extraction step. The pipeline keeps no field referencing
// a video frame, `ImageBitmap`, canvas snapshot, or any derived image; after
// extraction the canvas is cleared and the local frame reference goes out of
// scope. Nothing is written to storage and no network client for imagery
// exists in this module.
//
// Testability: the FaceMesh landmarker and the media stream / clock / frame
// scheduler are injectable. In tests the webcam and FaceMesh are mocked with
// generated landmark/frame streams, which keeps the frame-lifecycle and
// face-loss logic verifiable without a real camera. The default implementation
// wires `@mediapipe/tasks-vision`'s `FaceLandmarker`.

import type { AggregatedWindow, FeatureAggregator } from "@/lib/vision/aggregator";
import { createFeatureAggregator } from "@/lib/vision/aggregator";
import type { Classifier } from "@/lib/vision/classifier";
import { createClassifier } from "@/lib/vision/classifier";
import type { Landmark } from "@/lib/vision/features";
import { FeatureExtractor } from "@/lib/vision/features";
import type {
  CognitiveLoadSource,
  CognitiveLoadState,
  LoadSample,
  LoadSampleListener,
  Unsubscribe,
} from "@/lib/load/source";
import { SampleEmitter } from "@/lib/load/source";

/** Target capture frame rate (Req 3.1): at least 15 frames per second. */
export const TARGET_FPS = 15;

/** Minimum interval between processed frames to meet {@link TARGET_FPS}. */
export const MIN_FRAME_INTERVAL_MS = 1000 / TARGET_FPS;

/** Window advance step (Req 3.3): the aggregator advances once per second. */
export const WINDOW_STEP_MS = 1000;

/**
 * Sustained face-loss threshold (Req 3.6): no face detected continuously for at
 * least this many milliseconds discards retained features and triggers the
 * controller fallback to the Simulated_Trigger.
 */
export const SUSTAINED_FACE_LOSS_MS = 5000;

/**
 * Hard budget (Req 2.6) within which each captured frame reference must be
 * released after feature extraction. The pipeline releases synchronously, well
 * inside this bound; the constant documents the contract for callers/tests.
 */
export const FRAME_RELEASE_BUDGET_MS = 100;

/**
 * A video-frame source the capture loop can draw and measure. In the browser
 * this is an `HTMLVideoElement`; the subset used here (dimensions + usable as a
 * `drawImage` source) is captured by this structural type so tests can supply a
 * lightweight stand-in.
 */
export type VideoFrameSource = CanvasImageSource & {
  readonly videoWidth: number;
  readonly videoHeight: number;
};

/**
 * The minimal FaceMesh landmarker contract the pipeline depends on. Returns the
 * detected face landmarks for the supplied frame at time `timestampMs`, or an
 * empty array when no face is present. Injectable so tests can drive the
 * face-loss logic with generated landmark streams and the real
 * `@mediapipe/tasks-vision` `FaceLandmarker` is used in production.
 */
export interface FaceLandmarker {
  /**
   * Detect landmarks for one frame. An empty landmark array signals "no face"
   * for that frame (Req 3.5). Must be synchronous so the frame reference can be
   * released immediately after it returns (Req 2.6).
   */
  detect(frame: VideoFrameSource, timestampMs: number): readonly Landmark[];
  /** Release any resources held by the landmarker. */
  close?(): void;
}

/**
 * Schedules the next capture-loop tick. Mirrors `requestVideoFrameCallback` /
 * `requestAnimationFrame`: returns a handle that `cancelFrame` cancels.
 * Injectable so tests can drive the loop deterministically.
 */
export type RequestFrame = (cb: (now: number) => void) => number;
/** Cancels a pending {@link RequestFrame} handle. */
export type CancelFrame = (handle: number) => void;

/** Monotonic clock in ms. Injectable for determinism (defaults to performance.now). */
export type ClockFn = () => number;

/** Factory that opens the webcam stream (defaults to navigator.mediaDevices.getUserMedia). */
export type GetUserMediaFn = (
  constraints: MediaStreamConstraints,
) => Promise<MediaStream>;

/**
 * Error surfaced when the webcam cannot be opened (denied or unavailable). The
 * harness reacts to this: end the study (Req 2.7) or fall back to simulated and
 * inform the participant (Req 3.7). Carries the underlying cause.
 */
export class WebcamUnavailableError extends Error {
  readonly cause?: unknown;
  constructor(message: string, cause?: unknown) {
    super(message);
    this.name = "WebcamUnavailableError";
    this.cause = cause;
  }
}

/** A callback the controller/harness supplies to perform the simulated fallback. */
export type FallbackHandler = () => void;

/** Options for {@link WebcamVisionPipeline}. */
export interface VisionPipelineOptions {
  /** FaceMesh landmarker. Required in tests; defaults to a tasks-vision one in the browser. */
  landmarker?: FaceLandmarker;
  /** Pre-built aggregator (defaults to a fresh trailing 5s / 1s-step aggregator). */
  aggregator?: FeatureAggregator;
  /** Classifier instance (defaults to the shipped TF.js CNN-GRU classifier). */
  classifier?: Classifier;
  /** Feature extractor (defaults to a fresh {@link FeatureExtractor}). */
  featureExtractor?: FeatureExtractor;
  /** Webcam opener (defaults to `navigator.mediaDevices.getUserMedia`). */
  getUserMedia?: GetUserMediaFn;
  /** Frame scheduler (defaults to rVFC when available, else rAF). */
  requestFrame?: RequestFrame;
  /** Cancel for the frame scheduler. */
  cancelFrame?: CancelFrame;
  /** Monotonic clock (defaults to `performance.now`). */
  clock?: ClockFn;
  /**
   * Invoked once when no face has been seen for >= {@link SUSTAINED_FACE_LOSS_MS}
   * (Req 3.6). Wire this to `LoadSourceController.fallbackToSimulated(sim)`.
   */
  onFallbackToSimulated?: FallbackHandler;
  /** Video element to render the stream into (defaults to a detached one). */
  videoElement?: HTMLVideoElement;
  /** Offscreen canvas used only transiently during extraction (defaults to a fresh one). */
  canvas?: HTMLCanvasElement;
}

/** The Vision_Pipeline contract (design.md §Vision_Pipeline, Req 3). */
export interface VisionPipeline extends CognitiveLoadSource {
  readonly kind: "webcam";
}

function defaultClock(): number {
  if (typeof performance !== "undefined" && typeof performance.now === "function") {
    return performance.now();
  }
  return Date.now();
}

function isBrowser(): boolean {
  return typeof window !== "undefined" && typeof navigator !== "undefined";
}

/**
 * Build a frame scheduler. Prefers `requestVideoFrameCallback` on the video
 * element (fires once per presented frame, the natural >=15fps cadence,
 * Req 3.1); otherwise falls back to `requestAnimationFrame`; otherwise a
 * `setTimeout` pump at the target interval (used under SSR/test defaults).
 */
function makeDefaultScheduler(
  video: HTMLVideoElement | null,
): { request: RequestFrame; cancel: CancelFrame } {
  const anyVideo = video as unknown as {
    requestVideoFrameCallback?: (cb: (now: number) => void) => number;
    cancelVideoFrameCallback?: (handle: number) => void;
  } | null;

  if (anyVideo && typeof anyVideo.requestVideoFrameCallback === "function") {
    return {
      request: (cb) => anyVideo.requestVideoFrameCallback!((now) => cb(now)),
      cancel: (h) => anyVideo.cancelVideoFrameCallback?.(h),
    };
  }

  if (isBrowser() && typeof requestAnimationFrame === "function") {
    return {
      request: (cb) => requestAnimationFrame((now) => cb(now)),
      cancel: (h) => cancelAnimationFrame(h),
    };
  }

  // Last-resort pump (SSR import / non-DOM test default): schedule at target fps.
  return {
    request: (cb) =>
      setTimeout(() => cb(defaultClock()), MIN_FRAME_INTERVAL_MS) as unknown as number,
    cancel: (h) => clearTimeout(h as unknown as ReturnType<typeof setTimeout>),
  };
}

/**
 * Concrete Vision_Pipeline (Req 3). Owns the capture loop, frame lifecycle, and
 * face-loss state machine; delegates feature math to {@link FeatureExtractor},
 * windowing to the {@link FeatureAggregator}, and inference to the
 * {@link Classifier}. Emits `simulated: false` {@link LoadSample}s.
 */
export class WebcamVisionPipeline implements VisionPipeline {
  readonly kind = "webcam" as const;

  private readonly emitter = new SampleEmitter();
  private readonly aggregator: FeatureAggregator;
  private readonly classifier: Classifier;
  private readonly features: FeatureExtractor;
  private readonly getUserMedia: GetUserMediaFn;
  private readonly clock: ClockFn;
  private readonly onFallbackToSimulated?: FallbackHandler;

  private injectedRequestFrame?: RequestFrame;
  private injectedCancelFrame?: CancelFrame;
  private requestFrame: RequestFrame;
  private cancelFrame: CancelFrame;

  private readonly landmarker: FaceLandmarker | null;

  private video: HTMLVideoElement | null;
  private canvas: HTMLCanvasElement | null;
  private stream: MediaStream | null = null;

  private running = false;
  private frameHandle: number | null = null;

  /** Last time a frame was processed (for the >=15fps throttle). */
  private lastFrameT: number | null = null;
  /** Exclusive end of the next window to emit; advances by WINDOW_STEP_MS. */
  private nextWindowT: number | null = null;
  /** The last few aggregated windows, for the classifier's 5-step input. */
  private readonly windowHistory: AggregatedWindow[] = [];

  /** Timestamp of the last frame in which a face WAS detected; null if none yet. */
  private lastFaceT: number | null = null;
  /** True once sustained-loss fallback has fired, so it fires only once. */
  private fellBackToSimulated = false;

  constructor(options: VisionPipelineOptions = {}) {
    this.aggregator = options.aggregator ?? createFeatureAggregator({ stepMs: WINDOW_STEP_MS });
    this.classifier = options.classifier ?? createClassifier();
    this.features = options.featureExtractor ?? new FeatureExtractor();
    this.clock = options.clock ?? defaultClock;
    this.onFallbackToSimulated = options.onFallbackToSimulated;
    this.landmarker = options.landmarker ?? null;

    this.getUserMedia =
      options.getUserMedia ??
      ((constraints) => {
        if (!isBrowser() || !navigator.mediaDevices?.getUserMedia) {
          return Promise.reject(
            new WebcamUnavailableError("getUserMedia is unavailable in this environment"),
          );
        }
        return navigator.mediaDevices.getUserMedia(constraints);
      });

    this.injectedRequestFrame = options.requestFrame;
    this.injectedCancelFrame = options.cancelFrame;
    // Provisional scheduler; replaced with a video-bound one in start() when the
    // caller did not inject a scheduler and a real video element exists.
    const provisional = makeDefaultScheduler(null);
    this.requestFrame = options.requestFrame ?? provisional.request;
    this.cancelFrame = options.cancelFrame ?? provisional.cancel;

    this.video =
      options.videoElement ??
      (isBrowser() && typeof document !== "undefined"
        ? document.createElement("video")
        : null);
    this.canvas =
      options.canvas ??
      (isBrowser() && typeof document !== "undefined"
        ? document.createElement("canvas")
        : null);
  }

  /**
   * Open the webcam and start the capture loop. MUST only be called after the
   * caller has confirmed consent (Req 2.1, 2.3) — the pipeline does not request
   * media before this. Rejects with {@link WebcamUnavailableError} when the
   * webcam is denied/unavailable (Req 2.7, 3.7) and also emits an error-bearing
   * notification to any attached error listeners.
   *
   * The classifier is loaded lazily here; if it is already loaded (idempotent
   * `load`) this is cheap.
   */
  async start(): Promise<void> {
    if (this.running) return;

    let stream: MediaStream;
    try {
      stream = await this.getUserMedia({ video: true });
    } catch (err) {
      const wrapped =
        err instanceof WebcamUnavailableError
          ? err
          : new WebcamUnavailableError(
              "Webcam access was denied or is unavailable",
              err,
            );
      this.notifyError(wrapped);
      throw wrapped;
    }
    this.stream = stream;

    // Load the classifier (idempotent). A load failure is surfaced like a
    // webcam failure so the harness can react; the stream is released first.
    try {
      await this.classifier.load();
    } catch (err) {
      this.releaseStream();
      const wrapped = new WebcamUnavailableError(
        "Cognitive-load classifier failed to load",
        err,
      );
      this.notifyError(wrapped);
      throw wrapped;
    }

    // Attach the stream to the video element and begin playback so the frame
    // scheduler has presented frames to work with.
    if (this.video) {
      try {
        this.video.srcObject = stream;
        this.video.muted = true;
        (this.video as unknown as { playsInline?: boolean }).playsInline = true;
        await this.video.play?.();
      } catch {
        // Autoplay restrictions won't stop the pump-based scheduler; ignore.
      }
    }

    // Choose the final scheduler now that a real video element may exist.
    if (!this.injectedRequestFrame || !this.injectedCancelFrame) {
      const sched = makeDefaultScheduler(this.video);
      this.requestFrame = this.injectedRequestFrame ?? sched.request;
      this.cancelFrame = this.injectedCancelFrame ?? sched.cancel;
    }

    this.running = true;
    this.lastFrameT = null;
    this.nextWindowT = null;
    this.lastFaceT = null;
    this.fellBackToSimulated = false;

    this.scheduleNext();
  }

  /** Stop the capture loop and release the webcam. Retains the latest sample. */
  stop(): void {
    this.running = false;
    if (this.frameHandle !== null) {
      this.cancelFrame(this.frameHandle);
      this.frameHandle = null;
    }
    this.releaseStream();
  }

  subscribe(cb: LoadSampleListener): Unsubscribe {
    return this.emitter.subscribe(cb);
  }

  latest(): LoadSample | null {
    return this.emitter.latest();
  }

  /**
   * Subscribe to pipeline errors (webcam denied/unavailable, classifier load
   * failure). The harness uses this to end the study or fall back to simulated.
   */
  onError(cb: (error: WebcamUnavailableError) => void): Unsubscribe {
    this.errorListeners.add(cb);
    return () => {
      this.errorListeners.delete(cb);
    };
  }

  private readonly errorListeners = new Set<(error: WebcamUnavailableError) => void>();

  private notifyError(error: WebcamUnavailableError): void {
    for (const listener of [...this.errorListeners]) {
      listener(error);
    }
  }

  /** Schedule the next capture-loop iteration. */
  private scheduleNext(): void {
    if (!this.running) return;
    this.frameHandle = this.requestFrame((now) => this.onFrame(now));
  }

  /**
   * One capture-loop iteration. Throttles to >= 15 fps, processes the frame
   * (releasing it within the budget), updates the face-loss machine, and
   * advances the window / runs inference on each 1-second boundary.
   */
  private onFrame(now: number): void {
    if (!this.running) return;

    const t = Number.isFinite(now) ? now : this.clock();

    // Throttle so we process at most ~TARGET_FPS; still reschedule promptly.
    if (this.lastFrameT !== null && t - this.lastFrameT < MIN_FRAME_INTERVAL_MS) {
      this.scheduleNext();
      return;
    }
    this.lastFrameT = t;

    const faceSeen = this.processFrame(t);
    this.updateFaceLoss(faceSeen, t);
    this.maybeAdvanceWindow(t);

    this.scheduleNext();
  }

  /**
   * Draw the current frame, extract landmarks, feed features to the aggregator,
   * then release the frame reference and clear the canvas — all synchronously so
   * no frame/derived-image reference survives this method (Req 2.6, Property 5).
   *
   * Returns true when a face was detected in this frame, false otherwise.
   */
  private processFrame(t: number): boolean {
    // When no landmarker or video is available (e.g. pure pump default without a
    // mock), treat the frame as a no-face frame so the degraded/face-loss logic
    // still runs deterministically.
    if (!this.landmarker || !this.video) {
      return false;
    }

    const width = this.video.videoWidth || this.canvas?.width || 0;
    const height = this.video.videoHeight || this.canvas?.height || 0;

    // Draw to the offscreen canvas purely to hand pixels to the landmarker. The
    // canvas and the frame are transient: both are cleared / dropped below.
    let ctx: CanvasRenderingContext2D | null = null;
    if (this.canvas && width > 0 && height > 0) {
      this.canvas.width = width;
      this.canvas.height = height;
      ctx = this.canvas.getContext("2d");
      ctx?.drawImage(this.video as CanvasImageSource, 0, 0, width, height);
    }

    let landmarks: readonly Landmark[] = [];
    try {
      landmarks = this.landmarker.detect(this.video as VideoFrameSource, t);
    } finally {
      // Privacy: release the frame-derived pixels immediately (Req 2.6). Clear
      // the canvas and never retain the frame, a snapshot, or any derived image.
      if (ctx && width > 0 && height > 0) {
        ctx.clearRect(0, 0, width, height);
      }
    }

    if (!landmarks || landmarks.length === 0) {
      // No face this frame: do not push a feature frame. The aggregator will
      // treat the empty window slot as degraded and reuse prior features
      // (Req 3.5, Property 9).
      return false;
    }

    // Face present: compute per-frame features and buffer them. `landmarks` is
    // the only frame-derived data retained, and only as numeric feature values
    // after this call — no pixels.
    const frame = this.features.process(landmarks, t);
    this.aggregator.pushFrame(frame);
    return true;
  }

  /**
   * Update the sustained-face-loss machine (Req 3.5, 3.6).
   *
   * A single no-face frame leaves retained features intact (the aggregator
   * marks that window slot degraded). Once no face has been seen continuously
   * for >= {@link SUSTAINED_FACE_LOSS_MS}, the retained aggregated features are
   * discarded and the controller is asked to fall back to the Simulated_Trigger
   * exactly once (Req 3.6, Property 10).
   */
  private updateFaceLoss(faceSeen: boolean, t: number): void {
    if (faceSeen) {
      this.lastFaceT = t;
      this.fellBackToSimulated = false;
      return;
    }

    // No face this frame. If we have never seen a face, anchor the loss start to
    // now so the 5s clock is well-defined.
    if (this.lastFaceT === null) {
      this.lastFaceT = t;
      return;
    }

    const lossMs = t - this.lastFaceT;
    if (lossMs >= SUSTAINED_FACE_LOSS_MS && !this.fellBackToSimulated) {
      this.fellBackToSimulated = true;
      // Discard retained aggregated features so stale state cannot leak after
      // the fallback (Req 3.6).
      this.windowHistory.length = 0;
      this.features.reset();
      // Ask the controller/harness to switch the active source to simulated.
      this.onFallbackToSimulated?.();
    }
  }

  /**
   * On each 1-second boundary, advance the aggregator, run the classifier over
   * the trailing windows, and emit a `simulated: false` sample (Req 3.3, 3.4).
   */
  private maybeAdvanceWindow(t: number): void {
    if (this.nextWindowT === null) {
      // Anchor the first window boundary one step ahead of the first frame.
      this.nextWindowT = t + WINDOW_STEP_MS;
      return;
    }
    if (t < this.nextWindowT) {
      return;
    }

    // Advance for every elapsed 1-second boundary (robust to jitter), but emit
    // at most one sample per call using the newest window.
    let window: AggregatedWindow | null = null;
    while (this.nextWindowT !== null && t >= this.nextWindowT) {
      window = this.aggregator.advanceWindow();
      this.nextWindowT += WINDOW_STEP_MS;
    }
    if (!window) return;

    this.windowHistory.push(window);
    if (this.windowHistory.length > 5) {
      this.windowHistory.splice(0, this.windowHistory.length - 5);
    }

    const result = this.classifier.predict([...this.windowHistory]);
    const sample: LoadSample = {
      state: result.state as CognitiveLoadState,
      ear: window.ear,
      blinkRate: window.blinkRate,
      saccadeVelocity: window.saccadeVelocity,
      latencyMs: result.latencyMs,
      timestamp: this.clock(),
      degraded: window.degraded,
      simulated: false,
    };
    this.emitter.emit(sample);
  }

  /** Stop all tracks and drop the stream/video references. */
  private releaseStream(): void {
    if (this.stream) {
      for (const track of this.stream.getTracks()) {
        try {
          track.stop();
        } catch {
          // ignore
        }
      }
      this.stream = null;
    }
    if (this.video) {
      try {
        this.video.srcObject = null;
      } catch {
        // ignore
      }
    }
  }
}

/** Create a Vision_Pipeline cognitive-load source (Req 3). */
export function createVisionPipeline(
  options?: VisionPipelineOptions,
): WebcamVisionPipeline {
  return new WebcamVisionPipeline(options);
}

// -----------------------------------------------------------------------------
// Default MediaPipe FaceMesh landmarker adapter
// -----------------------------------------------------------------------------
//
// Wraps `@mediapipe/tasks-vision`'s `FaceLandmarker` behind the pipeline's
// synchronous {@link FaceLandmarker} contract. The underlying task is created
// asynchronously (it fetches the WASM runtime + model); callers await
// {@link createMediaPipeFaceLandmarker} once, then pass the result as the
// pipeline's `landmarker`. Per-frame detection via `detectForVideo` is
// synchronous, so the frame reference is released immediately after it returns
// (Req 2.6). This adapter is only loaded in the browser.

/** Default CDN base for the tasks-vision WASM runtime files. */
export const DEFAULT_MEDIAPIPE_WASM_BASE =
  "https://cdn.jsdelivr.net/npm/@mediapipe/tasks-vision@0.10.35/wasm";

/** Default FaceLandmarker model asset (float16 face landmarks bundle). */
export const DEFAULT_FACE_LANDMARKER_MODEL =
  "https://storage.googleapis.com/mediapipe-models/face_landmarker/face_landmarker/float16/1/face_landmarker.task";

/** Options for {@link createMediaPipeFaceLandmarker}. */
export interface MediaPipeFaceLandmarkerOptions {
  /** Base URL for the tasks-vision WASM files. */
  wasmBase?: string;
  /** URL/path of the `.task` FaceLandmarker model asset. */
  modelAssetPath?: string;
}

/**
 * Create the default MediaPipe FaceMesh landmarker adapter. Must run in the
 * browser. The returned object implements the pipeline's {@link FaceLandmarker}
 * contract: `detect` returns the first detected face's landmarks (empty array
 * when no face is present) and `close` releases the task.
 */
export async function createMediaPipeFaceLandmarker(
  options: MediaPipeFaceLandmarkerOptions = {},
): Promise<FaceLandmarker> {
  if (!isBrowser()) {
    throw new Error(
      "createMediaPipeFaceLandmarker() must run in a browser context.",
    );
  }

  const { FilesetResolver, FaceLandmarker: MpFaceLandmarker } = await import(
    "@mediapipe/tasks-vision"
  );

  const fileset = await FilesetResolver.forVisionTasks(
    options.wasmBase ?? DEFAULT_MEDIAPIPE_WASM_BASE,
  );

  const task = await MpFaceLandmarker.createFromOptions(fileset, {
    baseOptions: {
      modelAssetPath: options.modelAssetPath ?? DEFAULT_FACE_LANDMARKER_MODEL,
    },
    runningMode: "VIDEO",
    numFaces: 1,
  });

  return {
    detect(frame: VideoFrameSource, timestampMs: number): readonly Landmark[] {
      const result = task.detectForVideo(
        frame as unknown as HTMLVideoElement,
        timestampMs,
      );
      const faces = result.faceLandmarks;
      if (!faces || faces.length === 0) {
        return [];
      }
      // One face configured; map normalized points to the pipeline's Landmark.
      return faces[0].map((p) => ({ x: p.x, y: p.y, z: p.z }));
    },
    close(): void {
      task.close();
    },
  };
}
