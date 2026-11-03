// Feature: webcam-no-face-detection (bugfix spec)
//
// Property 3: Face-Visibility Notification - HUD indicator reflects the latest
// webcam sample.
//
// The Monitor HUD shows exactly one face indicator determined by the latest
// sample (design `faceIndicatorShown`): "✓ FACE DETECTED" for a webcam sample
// with faceDetected: true, "⚠ NO FACE DETECTED — please face the camera" for
// faceDetected: false, and none for a simulated sample, a null sample, or an
// undefined faceDetected. SIMULATED INPUT ACTIVE is unchanged.
//
// **Validates: Requirements 2.7, 2.8, 3.7, 3.8**

import { describe, it, expect, afterEach } from "vitest";
import { render, screen, cleanup } from "@testing-library/react";
import fc from "fast-check";
import MonitorHUD from "./MonitorHUD";
import { COGNITIVE_LOAD_STATES, type LoadSample } from "@/lib/load/source";

const FACE_OK = "✓ FACE DETECTED";
const NO_FACE = "⚠ NO FACE DETECTED — please face the camera";
/** Matches either face indicator text. */
const ANY_FACE = /FACE DETECTED/;

type FaceIndicator = "FACE_DETECTED" | "NO_FACE" | "NONE";

/** Reference oracle, transcribed from design.md `faceIndicatorShown`. */
function faceIndicatorShown(sample: LoadSample | null): FaceIndicator {
  if (sample === null || sample.simulated || sample.faceDetected === undefined) {
    return "NONE";
  }
  return sample.faceDetected ? "FACE_DETECTED" : "NO_FACE";
}

/** Read the face indicator actually rendered, asserting at most one is present. */
function renderedIndicator(): FaceIndicator {
  const matches = screen.queryAllByText(ANY_FACE);
  expect(matches.length).toBeLessThanOrEqual(1);
  if (matches.length === 0) return "NONE";
  const text = matches[0].textContent;
  if (text === FACE_OK) return "FACE_DETECTED";
  if (text === NO_FACE) return "NO_FACE";
  throw new Error(`Unexpected face indicator text: ${text}`);
}

const baseSample = (overrides: Partial<LoadSample> = {}): LoadSample => ({
  state: "LOW",
  ear: 0.3,
  blinkRate: 15,
  saccadeVelocity: 200,
  latencyMs: 2,
  timestamp: 1000,
  degraded: false,
  simulated: false,
  ...overrides,
});

const noop = () => {};

function renderHUD(sample: LoadSample | null) {
  return render(
    <MonitorHUD sample={sample} onSimulate={noop} onForceDeclutter={noop} onReset={noop} />,
  );
}

afterEach(() => {
  cleanup();
});

describe("Property 3: Monitor HUD face indicator (examples)", () => {
  it("webcam sample with faceDetected: true shows the FACE DETECTED status", () => {
    renderHUD(baseSample({ faceDetected: true }));
    const el = screen.getByText(FACE_OK);
    expect(el).toHaveAttribute("role", "status");
    expect(el).toHaveAttribute("aria-live", "polite");
    expect(screen.getAllByRole("status")).toContain(el);
    expect(screen.queryByText(NO_FACE)).toBeNull();
  });

  it("webcam sample with faceDetected: false shows the NO FACE DETECTED status", () => {
    renderHUD(baseSample({ faceDetected: false }));
    const el = screen.getByText(NO_FACE);
    expect(el).toHaveAttribute("role", "status");
    expect(screen.queryByText(FACE_OK)).toBeNull();
  });

  it("simulated sample shows SIMULATED INPUT ACTIVE and no face banner", () => {
    renderHUD(baseSample({ simulated: true }));
    expect(screen.getByText("SIMULATED INPUT ACTIVE")).toBeInTheDocument();
    expect(screen.queryByText(ANY_FACE)).toBeNull();
  });

  it("null sample shows no face banner", () => {
    renderHUD(null);
    expect(screen.queryByText(ANY_FACE)).toBeNull();
  });

  it("webcam sample with faceDetected undefined shows no face banner", () => {
    renderHUD(baseSample());
    expect(screen.queryByText(ANY_FACE)).toBeNull();
    expect(screen.queryByText("SIMULATED INPUT ACTIVE")).toBeNull();
  });

  it("rerendering true -> false updates the same status element's text", () => {
    const { rerender } = renderHUD(baseSample({ faceDetected: true }));
    const el = screen.getByText(FACE_OK);
    rerender(
      <MonitorHUD
        sample={baseSample({ faceDetected: false, timestamp: 2000 })}
        onSimulate={noop}
        onForceDeclutter={noop}
        onReset={noop}
      />,
    );
    const after = screen.getByText(NO_FACE);
    expect(after).toBe(el);
    expect(el).toHaveTextContent(NO_FACE);
    expect(screen.queryByText(FACE_OK)).toBeNull();
  });
});

describe("Property 3: rendered face indicator equals faceIndicatorShown(sample)", () => {
  const sampleArb: fc.Arbitrary<LoadSample | null> = fc.option(
    fc.record({
      state: fc.constantFrom(...COGNITIVE_LOAD_STATES),
      ear: fc.double({ min: 0, max: 0.5, noNaN: true }),
      blinkRate: fc.double({ min: 0, max: 40, noNaN: true }),
      saccadeVelocity: fc.double({ min: 0, max: 800, noNaN: true }),
      latencyMs: fc.double({ min: 0, max: 10, noNaN: true }),
      timestamp: fc.integer({ min: 0, max: 1_000_000 }),
      degraded: fc.boolean(),
      simulated: fc.boolean(),
      faceDetected: fc.constantFrom(true, false, undefined),
    }),
    { nil: null },
  );

  it("for any LoadSample | null", () => {
    fc.assert(
      fc.property(sampleArb, (sample) => {
        renderHUD(sample);
        try {
          expect(renderedIndicator()).toBe(faceIndicatorShown(sample));
          const simBanner = screen.queryByText("SIMULATED INPUT ACTIVE") !== null;
          expect(simBanner).toBe(sample?.simulated ?? false);
        } finally {
          cleanup();
        }
      }),
      { numRuns: 100 },
    );
  });
});
