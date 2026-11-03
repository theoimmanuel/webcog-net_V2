// Feature: webcam-no-face-detection (bugfix spec)
//
// Task 4.4 — Integration tests for the Scenario C flow.
//
// Renders the REAL StudyProvider + HarnessRunPage (`/study/run`) with Scenario C
// presented first (test-only `scenarioOrder` override -> "CAB"). Only test seams
// are swapped in, all around the real `WebcamVisionPipeline`:
//   - a fake classifier (no TF.js),
//   - a wrapped `createVisionPipeline` that injects a fake getUserMedia (fresh
//     stub MediaStream per call, with spied track.stop()), a manual frame
//     scheduler, a deterministic clock, and a stub video/canvas,
//   - a mocked `createMediaPipeFaceLandmarker` resolving a mock landmarker that
//     always sees a face (constant eye openness -> known EAR).
// The app's own options (classifier, landmarkerFactory, onFallbackToSimulated)
// are forwarded untouched, so this exercises the fixed production wiring.
//
// Scenario A/B Simulated_Trigger behaviour (Req 3.5) is already covered end to
// end by `app/study/run/page.preservation.test.tsx` (same provider + run page,
// asserting the controller stays simulated, no pipeline is built, and neither
// getUserMedia nor the MediaPipe factory is called), so it is referenced here
// rather than duplicated.
//
// **Validates: Requirements 2.2, 2.3, 2.4, 3.5**

import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import {
  render,
  screen,
  waitFor,
  act,
  cleanup,
  fireEvent,
  within,
} from "@testing-library/react";
import { useState } from "react";
import type { VisionPipelineOptions, WebcamVisionPipeline } from "@/lib/vision/pipeline";
import { SUSTAINED_FACE_LOSS_MS } from "@/lib/vision/pipeline";
import type { Landmark } from "@/lib/vision/features";
import {
  LEFT_EYE_EAR_INDICES,
  RIGHT_EYE_EAR_INDICES,
  LEFT_EYE_CENTER_INDEX,
  RIGHT_EYE_CENTER_INDEX,
} from "@/lib/vision/features";
import type { LoadSample } from "@/lib/load/source";
import type { ScenarioOrder } from "@/lib/harness/session";
import {
  StudyProvider,
  useStudy,
  type StudyContextValue,
} from "@/app/components/study/StudyProvider";
import HarnessRunPage from "./page";

// -----------------------------------------------------------------------------
// Hoisted harness state shared with the module mocks
// -----------------------------------------------------------------------------

const harness = vi.hoisted(() => ({
  now: 0,
  pending: new Map<number, (now: number) => void>(),
  nextHandle: 1,
  /** Landmarks the mock landmarker returns for every frame (face present). */
  face: [] as { x: number; y: number; z?: number }[],
  /** Every stub stream handed out by the fake getUserMedia. */
  streams: [] as { tracks: { stop: import("vitest").Mock }[] }[],
  /** Every pipeline the app built (should be exactly one, cached). */
  pipelines: [] as unknown[],
  stopSpies: [] as import("vitest").MockInstance<() => void>[],
  fallbackSpy: null as unknown as import("vitest").Mock,
  landmarkerFactory: null as unknown as import("vitest").Mock,
  landmarkerClose: null as unknown as import("vitest").Mock,
  detectCalls: 0,
}));

vi.mock("next/navigation", () => ({
  useRouter: () => ({ push: vi.fn(), replace: vi.fn(), prefetch: vi.fn() }),
}));

// Fake classifier: constant LOW with a 1 ms latency (distinct from the
// simulated trigger's ~2.2 ms) so HUD-bound webcam samples are recognisable.
vi.mock("@/lib/vision/classifier", () => ({
  createClassifier: () => ({
    load: async () => {},
    predict: () => ({ state: "LOW" as const, latencyMs: 1 }),
    modelSizeBytes: () => 1024,
  }),
}));

vi.mock("@/lib/vision/pipeline", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/lib/vision/pipeline")>();
  const { vi: v } = await import("vitest");

  harness.landmarkerClose = v.fn();
  const mockLandmarker = {
    detect: () => {
      harness.detectCalls += 1;
      return harness.face;
    },
    close: harness.landmarkerClose,
  };
  harness.landmarkerFactory = v.fn(async () => mockLandmarker);

  const createVisionPipeline = v.fn((appOptions: VisionPipelineOptions = {}) => {
    const appFallback = appOptions.onFallbackToSimulated;
    harness.fallbackSpy = v.fn(() => appFallback?.());

    const seams: VisionPipelineOptions = {
      getUserMedia: async () => {
        const tracks = [{ stop: v.fn() }];
        harness.streams.push({ tracks });
        return { getTracks: () => tracks } as unknown as MediaStream;
      },
      clock: () => harness.now,
      requestFrame: (cb) => {
        const h = harness.nextHandle++;
        harness.pending.set(h, cb);
        return h;
      },
      cancelFrame: (h) => {
        harness.pending.delete(h);
      },
      videoElement: {
        videoWidth: 0,
        videoHeight: 0,
        srcObject: null,
        muted: false,
        play: async () => {},
      } as unknown as HTMLVideoElement,
      canvas: { width: 0, height: 0, getContext: () => null } as unknown as HTMLCanvasElement,
    };

    const pipeline = new actual.WebcamVisionPipeline({
      ...seams,
      ...appOptions,
      onFallbackToSimulated: harness.fallbackSpy,
    });
    harness.stopSpies.push(v.spyOn(pipeline, "stop"));
    harness.pipelines.push(pipeline);
    return pipeline;
  });

  return {
    ...actual,
    createVisionPipeline,
    createMediaPipeFaceLandmarker: harness.landmarkerFactory,
  };
});

// -----------------------------------------------------------------------------
// Helpers
// -----------------------------------------------------------------------------

/** Test-only order override so Scenario C is presented first. */
const C_FIRST_ORDER: ScenarioOrder = ["C", "A", "B"];

/** Eye openness of the mock face; EAR = openness for this geometry. */
const OPENNESS = 0.45;

/** FaceMesh-shaped landmarks for a visible face with a known EAR. */
function faceLandmarks(openness: number): Landmark[] {
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

/** Drive `count` frames 100 ms apart (above the 15 fps throttle) inside act(). */
async function driveFrames(count: number): Promise<void> {
  await act(async () => {
    for (let i = 0; i < count; i++) {
      harness.now += 100;
      const due = [...harness.pending.values()];
      harness.pending.clear();
      for (const cb of due) cb(harness.now);
    }
  });
}

/** Live (not yet stopped) tracks across every stream handed out. */
function liveTracks(): number {
  return harness.streams.flatMap((s) => s.tracks).filter((t) => t.stop.mock.calls.length === 0)
    .length;
}

let ctx: StudyContextValue | null = null;
let setShowRun: ((show: boolean) => void) | null = null;

function Probe() {
  ctx = useStudy();
  return null;
}

/** Provider + run page; the run page can be unmounted/remounted independently. */
function App() {
  const [showRun, setShow] = useState(true);
  setShowRun = setShow;
  return (
    <StudyProvider scenarioOrder={C_FIRST_ORDER}>
      <Probe />
      {showRun && <HarnessRunPage />}
    </StudyProvider>
  );
}

/** Render, grant consent (assigns CAB), and wait for Scenario C's pipeline to run. */
async function presentScenarioC(): Promise<{ study: StudyContextValue; pipeline: WebcamVisionPipeline }> {
  render(<App />);
  await waitFor(() => expect(ctx?.ready).toBe(true));
  await act(async () => {
    ctx!.grantConsent(new Date().toISOString());
  });
  await waitFor(() => expect(ctx?.order?.[0]).toBe("C"));
  // start() resolved the landmarker and scheduled the first capture frame.
  await waitFor(() => expect(harness.pending.size).toBe(1));
  const study = ctx as unknown as StudyContextValue;
  return { study, pipeline: harness.pipelines[0] as WebcamVisionPipeline };
}

beforeEach(() => {
  window.localStorage.clear();
  window.sessionStorage.clear();
  harness.now = 1000;
  harness.pending.clear();
  harness.nextHandle = 1;
  harness.face = faceLandmarks(OPENNESS);
  harness.streams = [];
  harness.pipelines = [];
  harness.stopSpies = [];
  harness.detectCalls = 0;
  harness.landmarkerFactory.mockClear();
  harness.landmarkerClose.mockClear();
  ctx = null;
  setShowRun = null;
});

afterEach(() => {
  cleanup();
});

// -----------------------------------------------------------------------------
// Tests
// -----------------------------------------------------------------------------

describe("Scenario C integration (StudyProvider + HarnessRunPage)", () => {
  it("face-present frames drive non-simulated, landmark-derived samples to the controller and HUD with no spurious fallback", async () => {
    const { study, pipeline } = await presentScenarioC();
    const controller = study.controller!;

    // Wiring: one pipeline built, landmarker created once via the factory in
    // start(), webcam pipeline is the controller's active source.
    expect(harness.pipelines).toHaveLength(1);
    expect(harness.landmarkerFactory).toHaveBeenCalledTimes(1);
    expect(harness.streams).toHaveLength(1);
    expect(controller.getActiveSource()).toBe(pipeline);
    expect(controller.getActiveKind()).toBe("webcam");

    const received: LoadSample[] = [];
    const unsubscribe = controller.subscribe((s) => received.push(s));

    // Drive well past SUSTAINED_FACE_LOSS_MS of continuous face presence.
    const frames = Math.ceil((SUSTAINED_FACE_LOSS_MS + 2000) / 100);
    await driveFrames(frames);
    unsubscribe();

    // Every processed frame consulted the (mock) landmarker.
    expect(harness.detectCalls).toBe(frames);

    // HUD-bound samples are webcam samples reflecting the landmark features.
    expect(received.length).toBeGreaterThanOrEqual(5);
    for (const s of received) {
      expect(s.simulated).toBe(false);
      expect(s.faceDetected).toBe(true);
      expect(s.degraded).toBe(false);
      expect(s.ear).toBeCloseTo(OPENNESS, 5);
      expect(s.latencyMs).toBe(1);
    }

    // No spurious fallback while a face is present (Req 2.4).
    expect(harness.fallbackSpy).not.toHaveBeenCalled();
    expect(controller.getActiveKind()).toBe("webcam");
    expect(controller.latest()?.simulated).toBe(false);

    // The Scenario C HUD renders the webcam sample.
    const hud = screen.getByRole("region", { name: "WebCog-Net monitor" });
    expect(within(hud).getByText("✓ FACE DETECTED")).toBeInTheDocument();
    expect(within(hud).getByText(OPENNESS.toFixed(2))).toBeInTheDocument();
    expect(within(hud).getByText("1.0 ms")).toBeInTheDocument();
    expect(within(hud).queryByText("SIMULATED INPUT ACTIVE")).not.toBeInTheDocument();
    expect(within(hud).queryByText(/NO FACE DETECTED/)).not.toBeInTheDocument();
  });

  it("leaving Scenario C via the booking flow tears down the pipeline and returns the controller to simulated", async () => {
    const { study } = await presentScenarioC();
    const controller = study.controller!;
    await driveFrames(15);
    expect(controller.getActiveKind()).toBe("webcam");
    expect(liveTracks()).toBe(1);

    // Complete the booking task: pick a flight, fill the form, confirm.
    const list = screen.getByRole("region", { name: "Choose a flight" });
    fireEvent.click(within(list).getAllByRole("button")[0]);
    const fill = (label: string, value: string) =>
      fireEvent.change(screen.getByLabelText(label), { target: { value } });
    fill("Full name", "Test Participant");
    fill("Email", "participant@example.com");
    fill("Passengers", "1");
    fill("Card number", "4111111111111111");
    fill("Expiry (MM/YY)", "12/30");
    fill("CVC", "123");
    await act(async () => {
      fireEvent.click(screen.getByRole("button", { name: "Confirm booking" }));
    });

    // Moved on to the NASA-TLX: Scenario C's effect cleanup has run.
    await waitFor(() =>
      expect(screen.queryByRole("region", { name: "WebCog-Net monitor" })).not.toBeInTheDocument(),
    );
    expect(harness.stopSpies[0]).toHaveBeenCalled();
    expect(controller.getActiveKind()).toBe("simulated");
    expect(controller.getActiveSource()).toBe(study.simulated);
    // No stream or capture-loop leak.
    expect(liveTracks()).toBe(0);
    expect(harness.pending.size).toBe(0);

    // A frame callback arriving late cannot revive the stopped pipeline.
    const detectsBefore = harness.detectCalls;
    await driveFrames(5);
    expect(harness.detectCalls).toBe(detectsBefore);
    expect(controller.getActiveKind()).toBe("simulated");
  });

  it("returning to Scenario C restarts the cached pipeline without leaking a landmarker or stream", async () => {
    const { study, pipeline } = await presentScenarioC();
    const controller = study.controller!;
    await driveFrames(15);

    // Leave: unmount the run page (the effect cleanup path) while the provider
    // (which owns the cached pipeline) stays mounted.
    await act(async () => {
      setShowRun!(false);
    });
    expect(harness.stopSpies[0]).toHaveBeenCalledTimes(1);
    expect(controller.getActiveKind()).toBe("simulated");
    expect(liveTracks()).toBe(0);
    expect(harness.pending.size).toBe(0);

    // Return: remounting the run page re-presents Scenario C (index 0).
    await act(async () => {
      setShowRun!(true);
    });
    await waitFor(() => expect(harness.pending.size).toBe(1));

    // Same cached pipeline; the landmarker is reused (factory not re-run, never
    // closed/re-created); a fresh stream replaces the stopped one.
    expect(harness.pipelines).toHaveLength(1);
    expect(controller.getActiveSource()).toBe(pipeline);
    expect(harness.landmarkerFactory).toHaveBeenCalledTimes(1);
    expect(harness.streams).toHaveLength(2);
    expect(liveTracks()).toBe(1);

    // The restarted pipeline still produces face-present webcam samples.
    const received: LoadSample[] = [];
    const unsubscribe = controller.subscribe((s) => received.push(s));
    await driveFrames(Math.ceil((SUSTAINED_FACE_LOSS_MS + 1000) / 100));
    unsubscribe();
    expect(received.length).toBeGreaterThan(0);
    for (const s of received) {
      expect(s.simulated).toBe(false);
      expect(s.faceDetected).toBe(true);
      expect(s.ear).toBeCloseTo(OPENNESS, 5);
    }
    expect(harness.fallbackSpy).not.toHaveBeenCalled();
    expect(screen.getByText("✓ FACE DETECTED")).toBeInTheDocument();

    // Leave again: everything released.
    await act(async () => {
      setShowRun!(false);
    });
    expect(harness.stopSpies[0]).toHaveBeenCalledTimes(2);
    expect(controller.getActiveKind()).toBe("simulated");
    expect(liveTracks()).toBe(0);
    expect(harness.pending.size).toBe(0);
  });
});
