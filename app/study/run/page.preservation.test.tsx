// Feature: webcam-no-face-detection (bugfix spec)
//
// Property 2: Preservation - Scenarios A/B unchanged (Req 3.5).
//
// Observed on UNFIXED code: when the harness presents Scenario A or Scenario B
// (no webcam), the LoadSourceController keeps the Simulated_Trigger as its
// active source, no webcam Vision_Pipeline is built, getUserMedia is never
// requested, and no MediaPipe landmarker is created. The fix (which only adds
// a landmarker factory to the Scenario C pipeline) must not change this.
//
// **Validates: Requirements 3.5**

import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { render, screen, waitFor, act, cleanup } from "@testing-library/react";
import { StudyProvider, useStudy, type StudyContextValue } from "@/app/components/study/StudyProvider";
import type { ScenarioOrder } from "@/lib/harness/session";
import HarnessRunPage from "./page";

const spies = vi.hoisted(() => ({
  createVisionPipeline: null as unknown as import("vitest").Mock,
  createMediaPipeFaceLandmarker: null as unknown as import("vitest").Mock,
}));

vi.mock("next/navigation", () => ({
  useRouter: () => ({ push: vi.fn(), replace: vi.fn(), prefetch: vi.fn() }),
}));

// Avoid loading TF.js; Scenario A/B never use the classifier anyway.
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
  spies.createVisionPipeline = v.fn(actual.createVisionPipeline);
  spies.createMediaPipeFaceLandmarker = v.fn(actual.createMediaPipeFaceLandmarker);
  return {
    ...actual,
    createVisionPipeline: spies.createVisionPipeline,
    createMediaPipeFaceLandmarker: spies.createMediaPipeFaceLandmarker,
  };
});

let getUserMediaSpy: ReturnType<typeof vi.fn>;

beforeEach(() => {
  window.localStorage.clear();
  window.sessionStorage.clear();
  spies.createVisionPipeline.mockClear();
  spies.createMediaPipeFaceLandmarker.mockClear();
  getUserMediaSpy = vi.fn(async () => {
    throw new Error("getUserMedia must not be called for Scenarios A/B");
  });
  Object.defineProperty(navigator, "mediaDevices", {
    configurable: true,
    value: { getUserMedia: getUserMediaSpy },
  });
});

afterEach(() => {
  cleanup();
});

/** Render the real provider + run page and grant consent (assigns the order). */
async function presentFirstScenario(order?: ScenarioOrder): Promise<StudyContextValue> {
  let ctx: StudyContextValue | null = null;
  function Probe() {
    ctx = useStudy();
    return null;
  }
  render(
    <StudyProvider scenarioOrder={order}>
      <Probe />
      <HarnessRunPage />
    </StudyProvider>,
  );
  await waitFor(() => expect(ctx?.ready).toBe(true));
  await act(async () => {
    ctx!.grantConsent(new Date().toISOString());
  });
  await waitFor(() => expect(ctx?.order).not.toBeNull());
  return ctx as unknown as StudyContextValue;
}

describe("Property 2 (case 6): Scenarios A and B keep the Simulated_Trigger with no webcam pipeline", () => {
  it.each([
    // Default fixed order A-B-C (Scenario A first).
    { scenario: "A", order: undefined },
    // Test-only override so Scenario B is presented first.
    { scenario: "B", order: ["B", "A", "C"] as ScenarioOrder },
  ])("Scenario $scenario", async ({ scenario, order }) => {
    const ctx = await presentFirstScenario(order);

    expect(ctx.order?.[0]).toBe(scenario);
    // Without an override every participant gets the fixed A-B-C order.
    if (!order) expect(ctx.order).toEqual(["A", "B", "C"]);
    // The booking task for the presented scenario is on screen.
    await waitFor(() => expect(screen.getAllByRole("button").length).toBeGreaterThan(0));

    // Let any effects / async work settle.
    await act(async () => {
      await new Promise((r) => setTimeout(r, 50));
    });

    expect(ctx.controller?.getActiveKind()).toBe("simulated");
    expect(ctx.controller?.isSimulatedActive()).toBe(true);
    expect(ctx.controller?.latest()?.simulated).toBe(true);
    expect(spies.createVisionPipeline).not.toHaveBeenCalled();
    expect(spies.createMediaPipeFaceLandmarker).not.toHaveBeenCalled();
    expect(getUserMediaSpy).not.toHaveBeenCalled();
  });
});
