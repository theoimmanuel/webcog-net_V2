// lib/vision/calibration.ts
//
// Pure, DOM-free EAR-calibration logic.
//
// A short open-eyes baseline (default 5 s) is captured immediately after
// consent and before any scenario starts. The participant keeps their eyes open
// and looks at the screen normally. Their mean resting EAR is measured and
// a personalised blink-detection threshold is derived as:
//
//   threshold = mean_resting_EAR × THRESHOLD_RATIO   (default 0.75)
//
// 0.75 is a well-established fraction used in clinical and HCI eye-tracking
// studies: it sits comfortably below the fully-open resting value (~0.25–0.35
// for most adults at webcam resolution) while remaining well above the
// closed-eye value (~0.05), so accidental misdetections in both directions are
// minimised.
//
// This module holds no DOM / webcam references. The UI component
// (CalibrationStep.tsx) drives the webcam, extracts EAR values per frame using
// computeEAR() from features.ts, and calls these pure helpers to derive the
// final threshold.

import { DEFAULT_BLINK_THRESHOLD } from "@/lib/vision/features";

/** Ratio of resting mean EAR used to derive the personalised threshold. */
export const THRESHOLD_RATIO = 0.75;

/** Duration of the baseline capture window in milliseconds. */
export const CALIBRATION_DURATION_MS = 5_000;

/**
 * Minimum number of valid EAR samples required to trust the calibration result.
 * If fewer samples were collected the fallback default threshold is used instead
 * so a brief face-loss during calibration does not produce an erratic threshold.
 */
export const MIN_CALIBRATION_SAMPLES = 10;

/**
 * Minimum plausible resting EAR. Values below this almost certainly indicate
 * a closed eye or a tracking glitch, so they are excluded from the baseline
 * mean to prevent the threshold being pulled downward by blinks during the
 * calibration window.
 */
export const MIN_VALID_EAR = 0.15;

/**
 * Maximum plausible EAR. Values above this are typically landmark-tracking
 * artefacts (e.g. wide-eyed surprise or a momentary glitch) and are excluded
 * so they do not inflate the mean and push the threshold too high.
 */
export const MAX_VALID_EAR = 0.50;

/** Result returned by {@link deriveThreshold}. */
export interface CalibrationResult {
  /** Personalised threshold to pass as `blinkThreshold` to FeatureExtractor. */
  threshold: number;
  /** Mean of the accepted resting-EAR samples (diagnostic, stored in session). */
  meanRestingEar: number;
  /** Number of valid samples that contributed to the mean. */
  sampleCount: number;
  /**
   * True when not enough valid samples were collected and the global default
   * was used instead of a participant-specific value.
   */
  usedFallback: boolean;
}

/**
 * Derive a personalised blink-detection threshold from a raw EAR sample
 * sequence collected during the baseline window.
 *
 * Samples outside [{@link MIN_VALID_EAR}, {@link MAX_VALID_EAR}] are filtered
 * out before computing the mean, so blinks and landmark glitches during the
 * calibration window do not corrupt the result.
 *
 * When fewer than {@link MIN_CALIBRATION_SAMPLES} valid samples remain after
 * filtering, the function returns the global {@link DEFAULT_BLINK_THRESHOLD}
 * with `usedFallback: true`.
 */
export function deriveThreshold(rawSamples: readonly number[]): CalibrationResult {
  const valid = rawSamples.filter(
    (v) => Number.isFinite(v) && v >= MIN_VALID_EAR && v <= MAX_VALID_EAR,
  );

  if (valid.length < MIN_CALIBRATION_SAMPLES) {
    return {
      threshold: DEFAULT_BLINK_THRESHOLD,
      meanRestingEar: 0,
      sampleCount: valid.length,
      usedFallback: true,
    };
  }

  const mean = valid.reduce((s, v) => s + v, 0) / valid.length;
  const threshold = parseFloat((mean * THRESHOLD_RATIO).toFixed(4));

  // Safety clamp: never let the derived threshold fall below a floor that would
  // make every frame register as a blink, or above a ceiling that would make
  // blinks impossible to detect.
  const clamped = Math.min(Math.max(threshold, 0.10), 0.30);

  return {
    threshold: clamped,
    meanRestingEar: parseFloat(mean.toFixed(4)),
    sampleCount: valid.length,
    usedFallback: false,
  };
}
