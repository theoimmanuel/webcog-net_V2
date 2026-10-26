// Feature: webcog-net-site
//
// Pure, DOM-free feature extraction for the Vision_Pipeline (Req 3.2).
//
// Computes the three physiological signals the Classifier consumes:
//   - EAR (Eye Aspect Ratio): unitless, non-negative ratio.
//   - Blink events: detected by EAR crossing below a threshold and recovering.
//   - Saccade velocity: angular displacement of the eye-center landmark
//     between consecutive frames divided by inter-frame time, in deg/s.
//
// Landmarks are MediaPipe FaceMesh points. This module holds no DOM or webcam
// references and every exported function is a pure function of its inputs, so
// it is trivially unit- and property-testable.

/** A single MediaPipe FaceMesh landmark (normalized image coordinates). */
export interface Landmark {
  x: number;
  y: number;
  z?: number;
}

/**
 * Per-frame feature output consumed by the Feature_Aggregator.
 * Matches the shape declared in design.md / aggregator.ts.
 */
export interface FeatureFrame {
  /** Mean Eye Aspect Ratio for the frame, unitless and non-negative. */
  ear: number;
  /** 1 when this frame completed a blink (threshold cross + recover), else 0. */
  blink: 0 | 1;
  /** Angular eye-movement velocity for the frame, in degrees per second. */
  saccadeVelocity: number;
  /** Frame timestamp in milliseconds (performance.now()-based epoch). */
  t: number;
}

// -----------------------------------------------------------------------------
// MediaPipe FaceMesh landmark indices
// -----------------------------------------------------------------------------
// Standard six-point EAR landmark set per eye. Order is:
//   [p1, p2, p3, p4, p5, p6]
// where p1/p4 are the horizontal corners and (p2,p6) / (p3,p5) are the two
// vertical pairs used by the EAR formula.
//
// These are the commonly used FaceMesh indices for the left and right eyes.

/** Left-eye six-point EAR landmark indices (participant's left). */
export const LEFT_EYE_EAR_INDICES: readonly [number, number, number, number, number, number] = [
  33, 160, 158, 133, 153, 144,
];

/** Right-eye six-point EAR landmark indices (participant's right). */
export const RIGHT_EYE_EAR_INDICES: readonly [number, number, number, number, number, number] = [
  362, 385, 387, 263, 373, 380,
];

/** FaceMesh index approximating the center of the left iris/eye. */
export const LEFT_EYE_CENTER_INDEX = 468;
/** FaceMesh index approximating the center of the right iris/eye. */
export const RIGHT_EYE_CENTER_INDEX = 473;

// Fallbacks when refined iris landmarks (468/473) are unavailable: use the
// midpoint between the horizontal eye corners instead.
const LEFT_EYE_CORNERS: readonly [number, number] = [33, 133];
const RIGHT_EYE_CORNERS: readonly [number, number] = [362, 263];

/** Default EAR threshold below which an eye is considered closing (blink). */
export const DEFAULT_BLINK_THRESHOLD = 0.21;

/**
 * Default horizontal field-of-view (degrees) used to convert normalized
 * landmark displacement into an angular displacement for saccade velocity.
 * A typical webcam horizontal FOV is roughly 60°.
 */
export const DEFAULT_HORIZONTAL_FOV_DEG = 60;

// -----------------------------------------------------------------------------
// Geometry helpers
// -----------------------------------------------------------------------------

function distance(a: Landmark, b: Landmark): number {
  const dx = a.x - b.x;
  const dy = a.y - b.y;
  return Math.hypot(dx, dy);
}

function isFiniteNumber(n: number): boolean {
  return typeof n === "number" && Number.isFinite(n);
}

function requireLandmark(landmarks: readonly Landmark[], index: number): Landmark {
  const lm = landmarks[index];
  if (!lm || !isFiniteNumber(lm.x) || !isFiniteNumber(lm.y)) {
    throw new RangeError(`Missing or invalid landmark at index ${index}`);
  }
  return lm;
}

// -----------------------------------------------------------------------------
// EAR (Eye Aspect Ratio) — Req 3.2
// -----------------------------------------------------------------------------

/**
 * Compute the Eye Aspect Ratio for a single eye from its six EAR landmarks.
 *
 * Standard EAR formula:
 *   EAR = (|p2 - p6| + |p3 - p5|) / (2 * |p1 - p4|)
 *
 * The result is a non-negative, finite, unitless ratio. When the horizontal
 * span is zero (degenerate landmarks) the EAR is defined as 0.
 */
export function computeEyeEAR(
  landmarks: readonly Landmark[],
  indices: readonly [number, number, number, number, number, number],
): number {
  const [i1, i2, i3, i4, i5, i6] = indices;
  const p1 = requireLandmark(landmarks, i1);
  const p2 = requireLandmark(landmarks, i2);
  const p3 = requireLandmark(landmarks, i3);
  const p4 = requireLandmark(landmarks, i4);
  const p5 = requireLandmark(landmarks, i5);
  const p6 = requireLandmark(landmarks, i6);

  const vertical = distance(p2, p6) + distance(p3, p5);
  const horizontal = distance(p1, p4);

  if (horizontal <= 0) {
    return 0;
  }

  const ear = vertical / (2 * horizontal);
  // Guard against NaN/Infinity leaking out; clamp to non-negative.
  return isFiniteNumber(ear) && ear > 0 ? ear : 0;
}

/**
 * Compute the EAR averaged across both eyes.
 *
 * Returns a finite, non-negative, unitless ratio (Property 6).
 */
export function computeEAR(landmarks: readonly Landmark[]): number {
  const left = computeEyeEAR(landmarks, LEFT_EYE_EAR_INDICES);
  const right = computeEyeEAR(landmarks, RIGHT_EYE_EAR_INDICES);
  const ear = (left + right) / 2;
  return isFiniteNumber(ear) && ear >= 0 ? ear : 0;
}

// -----------------------------------------------------------------------------
// Blink detection — threshold cross + recover (Req 3.2)
// -----------------------------------------------------------------------------

/**
 * Mutable state for the streaming blink detector. A blink is counted once per
 * "cross below threshold then recover above threshold" cycle, so a single long
 * eye-closure yields exactly one blink.
 */
export interface BlinkDetectorState {
  /** True while EAR is currently below the threshold (eye closing/closed). */
  below: boolean;
  /** Threshold EAR value below which the eye is considered closing. */
  threshold: number;
}

/** Create a fresh blink-detector state. */
export function createBlinkDetector(
  threshold: number = DEFAULT_BLINK_THRESHOLD,
): BlinkDetectorState {
  return { below: false, threshold };
}

/**
 * Feed one EAR sample to the blink detector.
 *
 * Returns 1 exactly on the frame where EAR recovers back above the threshold
 * after having dropped below it (completing a blink), otherwise 0. The state is
 * mutated in place to track the crossing.
 */
export function detectBlink(state: BlinkDetectorState, ear: number): 0 | 1 {
  const safeEar = isFiniteNumber(ear) ? ear : 0;

  if (safeEar < state.threshold) {
    // Eye is closing / closed. Mark that we've crossed below; no event yet.
    state.below = true;
    return 0;
  }

  // EAR is at/above threshold.
  if (state.below) {
    // We previously crossed below and have now recovered: one blink completed.
    state.below = false;
    return 1;
  }

  return 0;
}

// -----------------------------------------------------------------------------
// Saccade velocity — deg/s (Req 3.2)
// -----------------------------------------------------------------------------

/**
 * Return the eye-center landmark used for saccade tracking: the midpoint of the
 * two iris/eye centers when refined iris landmarks are present, otherwise the
 * midpoint of the four horizontal eye corners.
 */
export function eyeCenter(landmarks: readonly Landmark[]): Landmark {
  const leftIris = landmarks[LEFT_EYE_CENTER_INDEX];
  const rightIris = landmarks[RIGHT_EYE_CENTER_INDEX];

  if (
    leftIris &&
    rightIris &&
    isFiniteNumber(leftIris.x) &&
    isFiniteNumber(leftIris.y) &&
    isFiniteNumber(rightIris.x) &&
    isFiniteNumber(rightIris.y)
  ) {
    return {
      x: (leftIris.x + rightIris.x) / 2,
      y: (leftIris.y + rightIris.y) / 2,
    };
  }

  // Fallback: average of the four horizontal eye corners.
  const l1 = requireLandmark(landmarks, LEFT_EYE_CORNERS[0]);
  const l2 = requireLandmark(landmarks, LEFT_EYE_CORNERS[1]);
  const r1 = requireLandmark(landmarks, RIGHT_EYE_CORNERS[0]);
  const r2 = requireLandmark(landmarks, RIGHT_EYE_CORNERS[1]);
  return {
    x: (l1.x + l2.x + r1.x + r2.x) / 4,
    y: (l1.y + l2.y + r1.y + r2.y) / 4,
  };
}

/**
 * Compute saccade velocity in degrees per second from the eye-center
 * displacement between two consecutive frames.
 *
 * The normalized (0..1) displacement is converted to an angle by scaling the
 * horizontal component against the configured horizontal field of view, then
 * divided by the inter-frame time in seconds. The result is non-negative.
 *
 * When the inter-frame time is zero or non-positive, velocity is defined as 0.
 */
export function computeSaccadeVelocity(
  prevCenter: Landmark,
  currCenter: Landmark,
  dtMs: number,
  horizontalFovDeg: number = DEFAULT_HORIZONTAL_FOV_DEG,
): number {
  if (!isFiniteNumber(dtMs) || dtMs <= 0) {
    return 0;
  }

  const displacement = distance(prevCenter, currCenter); // normalized units
  const degreesPerNormalizedUnit = horizontalFovDeg;
  const angularDisplacementDeg = displacement * degreesPerNormalizedUnit;
  const dtSeconds = dtMs / 1000;

  const velocity = angularDisplacementDeg / dtSeconds;
  return isFiniteNumber(velocity) && velocity >= 0 ? velocity : 0;
}

// -----------------------------------------------------------------------------
// Per-frame feature extraction
// -----------------------------------------------------------------------------

/** Options controlling feature extraction. */
export interface FeatureExtractorOptions {
  /** EAR threshold for blink detection. */
  blinkThreshold?: number;
  /** Horizontal field of view in degrees for saccade angular scaling. */
  horizontalFovDeg?: number;
}

/**
 * Streaming per-frame feature extractor. Holds only the small amount of state
 * needed to detect blinks across frames and to compute inter-frame saccade
 * velocity (the previous eye-center and timestamp). It holds no image data.
 */
export class FeatureExtractor {
  private readonly blink: BlinkDetectorState;
  private readonly horizontalFovDeg: number;
  private prevCenter: Landmark | null = null;
  private prevT: number | null = null;

  constructor(options: FeatureExtractorOptions = {}) {
    this.blink = createBlinkDetector(
      options.blinkThreshold ?? DEFAULT_BLINK_THRESHOLD,
    );
    this.horizontalFovDeg =
      options.horizontalFovDeg ?? DEFAULT_HORIZONTAL_FOV_DEG;
  }

  /**
   * Process one frame of landmarks captured at time `t` (ms) and return the
   * derived per-frame feature values. Pure with respect to its inputs given the
   * extractor's accumulated streaming state.
   */
  process(landmarks: readonly Landmark[], t: number): FeatureFrame {
    const ear = computeEAR(landmarks);
    const blink = detectBlink(this.blink, ear);

    const center = eyeCenter(landmarks);
    let saccadeVelocity = 0;
    if (this.prevCenter !== null && this.prevT !== null) {
      saccadeVelocity = computeSaccadeVelocity(
        this.prevCenter,
        center,
        t - this.prevT,
        this.horizontalFovDeg,
      );
    }

    this.prevCenter = center;
    this.prevT = t;

    return { ear, blink, saccadeVelocity, t };
  }

  /** Reset streaming state (e.g. after a tracking gap). */
  reset(): void {
    this.blink.below = false;
    this.prevCenter = null;
    this.prevT = null;
  }
}

/**
 * Convenience pure function: compute a single FeatureFrame given the current
 * landmarks, the previous frame's eye center and timestamp, and the running
 * blink-detector state. Useful for stateless callers and tests.
 */
export function computeFeatureFrame(
  landmarks: readonly Landmark[],
  t: number,
  blinkState: BlinkDetectorState,
  prev: { center: Landmark; t: number } | null,
  horizontalFovDeg: number = DEFAULT_HORIZONTAL_FOV_DEG,
): { frame: FeatureFrame; center: Landmark } {
  const ear = computeEAR(landmarks);
  const blink = detectBlink(blinkState, ear);
  const center = eyeCenter(landmarks);
  const saccadeVelocity = prev
    ? computeSaccadeVelocity(prev.center, center, t - prev.t, horizontalFovDeg)
    : 0;

  return { frame: { ear, blink, saccadeVelocity, t }, center };
}
