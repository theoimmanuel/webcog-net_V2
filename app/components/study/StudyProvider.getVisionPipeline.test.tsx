// Feature: webcam-no-face-detection (bugfix spec) — Task 4.2
//
// Unit tests for `StudyProvider.getVisionPipeline()`:
//  - it injects a `landmarkerFactory` that calls `createMediaPipeFaceLandmarker`
//    (lazily — only when the factory is invoked, i.e. inside `start()`);
//  - it stays synchronous, returning a `WebcamVisionPipeline` (not a promise)
//    after ready, and the same instance on repeat calls;
//  - classifier ownership (classifier passed into the pipeline options and read
//    by `getModelSizeBytes`) and the `onFallbackToSimulated` wiring (switches the
//    controller back to the simulated source) are unchanged.
//
// **Validates: Requirements 2.1, 2.5, 2.6**

import { describe, it, expect, vi, afterEach, beforeEach } from "vitest";
import { render, waitFor, cleanup, act } from "@testing-library/react";
import type { VisionPipelineOptions } from "@/lib/vision/pipeline";
import { WebcamVisionPipeline } from "@/lib/vision/pipeline";
import { StudyProvider, useStudy, type StudyContextValue } from "./StudyProvider";

// -----------------------------------------------------------------------------
// Hoisted mock state
// -----------------------------------------------------------------------------

const h = vi.hoisted(() => ({
  appOptions: null as VisionPipelineOptions | null,
  classifiers: [] as unknown[],
  landmarkerSentinel: { detect: () => [], close: () => {} },
}));

vi.mock("@/lib/vision/classifier", () => {
  const createClassifier = vi.fn(() => {
    const c = {
      load: async () => {},
      predict: () => ({ state: "LOW" as const, latencyMs: 1 }),
      modelSizeBytes: () => 4321,
    };
    h.classifiers.push(c);
    return c;
  });
  return { createClassifier };
});

vi.mock("@/lib/vision/pipeline", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/lib/vision/pipeline")>();

  const createMediaPipeFaceLandmarker = vi.fn(async () => h.landmarkerSentinel);

  const createVisionPipeline = vi.fn((appOptions: VisionPipelineOptions = {}) => {
    h.appOptions = appOptions;
    // Construct the real pipeline with DOM-free stubs; app options win.
    return new actual.WebcamVisionPipeline({
      videoElement: {} as HTMLVideoElement,
      canvas: { getContext: () => null } as unknown as HTMLCanvasElement,
      ...appOptions,
    });
  });

  return { ...actual, createVisionPipeline, createMediaPipeFaceLandmarker };
});

// Imported after vi.mock so these are the mocked spies.
import { createMediaPipeFaceLandmarker, createVisionPipeline } from "@/lib/vision/pipeline";
import { createClassifier } from "@/lib/vision/classifier";

// -----------------------------------------------------------------------------
// Helpers
// -----------------------------------------------------------------------------

async function renderProvider(): Promise<() => StudyContextValue> {
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
  return () => ctx as unknown as StudyContextValue;
}

beforeEach(() => {
  h.appOptions = null;
  h.classifiers = [];
  vi.mocked(createMediaPipeFaceLandmarker).mockClear();
  vi.mocked(createVisionPipeline).mockClear();
  vi.mocked(createClassifier).mockClear();
});

afterEach(() => {
  cleanup();
});

// -----------------------------------------------------------------------------
// Tests
// -----------------------------------------------------------------------------

describe("StudyProvider.getVisionPipeline()", () => {
  it("is synchronous and returns the same WebcamVisionPipeline instance on repeat calls", async () => {
    const getCtx = await renderProvider();

    const first = getCtx().getVisionPipeline();
    // Not a promise, not null, a real pipeline.
    expect(first).not.toBeNull();
    expect(first).not.toBeInstanceOf(Promise);
    expect(typeof (first as unknown as { then?: unknown }).then).toBe("undefined");
    expect(first).toBeInstanceOf(WebcamVisionPipeline);

    const second = getCtx().getVisionPipeline();
    expect(second).toBe(first);
    expect(createVisionPipeline).toHaveBeenCalledTimes(1);
  });

  it("injects a landmarkerFactory that lazily calls createMediaPipeFaceLandmarker", async () => {
    const getCtx = await renderProvider();
    getCtx().getVisionPipeline();

    const factory = h.appOptions?.landmarkerFactory;
    expect(typeof factory).toBe("function");
    // No explicit landmarker: the factory path is the one used in start().
    expect(h.appOptions?.landmarker).toBeUndefined();
    // Building the pipeline must not load MediaPipe yet.
    expect(createMediaPipeFaceLandmarker).not.toHaveBeenCalled();

    const result = await factory!();
    expect(createMediaPipeFaceLandmarker).toHaveBeenCalledTimes(1);
    expect(result).toBe(h.landmarkerSentinel);
  });

  it("keeps classifier ownership: passes the created classifier and getModelSizeBytes reads it", async () => {
    const getCtx = await renderProvider();
    // Before the pipeline exists, no classifier is owned.
    expect(getCtx().getModelSizeBytes()).toBe(0);

    getCtx().getVisionPipeline();
    expect(createClassifier).toHaveBeenCalledTimes(1);
    expect(h.classifiers).toHaveLength(1);
    expect(h.appOptions?.classifier).toBe(h.classifiers[0]);
    expect(getCtx().getModelSizeBytes()).toBe(4321);
  });

  it("keeps onFallbackToSimulated wiring: invoking it switches the controller to the simulated source", async () => {
    const getCtx = await renderProvider();
    const pipeline = getCtx().getVisionPipeline() as WebcamVisionPipeline;
    const { controller, simulated } = getCtx();
    expect(controller).not.toBeNull();
    expect(simulated).not.toBeNull();

    act(() => {
      controller!.setActiveSource(pipeline);
    });
    expect(controller!.getActiveSource()).toBe(pipeline);

    expect(typeof h.appOptions?.onFallbackToSimulated).toBe("function");
    act(() => {
      h.appOptions!.onFallbackToSimulated!();
    });
    expect(controller!.getActiveSource()).toBe(simulated);
  });
});
