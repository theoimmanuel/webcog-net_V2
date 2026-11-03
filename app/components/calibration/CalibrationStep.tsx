"use client";

/**
 * CalibrationStep — brief open-eyes EAR baseline capture shown between the
 * consent screen and the first scenario.
 *
 * Flow:
 *  1. Render an instruction screen asking the participant to look at the camera
 *     naturally with eyes open. A "Start calibration" button begins capture.
 *  2. On start: request the webcam, load the MediaPipe FaceLandmarker, then
 *     run a rAF capture loop for CALIBRATION_DURATION_MS (5 s), collecting one
 *     EAR sample per frame via computeEAR().
 *  3. On completion: call deriveThreshold() on the raw samples and hand the
 *     CalibrationResult to onComplete(). The webcam track is stopped
 *     immediately — the Vision_Pipeline (Scenario C) will re-open it later.
 *  4. Error path: if the webcam is denied or no face is found the component
 *     shows an error and an option to skip (falling back to the default
 *     threshold), so the study can still proceed.
 *
 * Privacy: no frame pixels are stored; only the scalar EAR value is retained
 * per frame. The webcam track is stopped as soon as the 5-second window closes.
 */

import { useCallback, useEffect, useId, useRef, useState } from "react";
import { computeEAR, type Landmark } from "@/lib/vision/features";
import {
  CALIBRATION_DURATION_MS,
  deriveThreshold,
  type CalibrationResult,
} from "@/lib/vision/calibration";
import {
  createMediaPipeFaceLandmarker,
  type FaceLandmarker,
} from "@/lib/vision/pipeline";
import { DEFAULT_BLINK_THRESHOLD } from "@/lib/vision/features";

export interface CalibrationStepProps {
  /**
   * Called when calibration finishes (either via measurement or skip).
   * Receives the derived CalibrationResult; `usedFallback: true` means the
   * default threshold was kept.
   */
  onComplete: (result: CalibrationResult) => void;
}

type CalibrationPhase =
  | "instruction" // waiting for the participant to click Start
  | "capturing"   // webcam open, collecting EAR samples
  | "done"        // threshold derived, ready to proceed
  | "error";      // webcam denied or no face found

/** Fallback result returned when the participant skips calibration. */
function makeFallbackResult(): CalibrationResult {
  return {
    threshold: DEFAULT_BLINK_THRESHOLD,
    meanRestingEar: 0,
    sampleCount: 0,
    usedFallback: true,
  };
}

export default function CalibrationStep({ onComplete }: CalibrationStepProps) {
  const [phase, setPhase] = useState<CalibrationPhase>("instruction");
  const [progress, setProgress] = useState(0); // 0–100 percent of CALIBRATION_DURATION_MS
  const [errorMsg, setErrorMsg] = useState<string | null>(null);
  const [result, setResult] = useState<CalibrationResult | null>(null);

  // Webcam / landmarker resources owned by this component for the 5-second
  // window only; all are released in stopCapture().
  const streamRef = useRef<MediaStream | null>(null);
  const videoRef = useRef<HTMLVideoElement | null>(null);
  const canvasRef = useRef<HTMLCanvasElement | null>(null);
  const landmarkerRef = useRef<FaceLandmarker | null>(null);
  const rafHandleRef = useRef<number | null>(null);
  const samplesRef = useRef<number[]>([]);
  const startTimeRef = useRef<number | null>(null);

  const headingId = useId();

  /** Release all webcam / DOM resources. Safe to call multiple times. */
  const stopCapture = useCallback(() => {
    if (rafHandleRef.current !== null) {
      cancelAnimationFrame(rafHandleRef.current);
      rafHandleRef.current = null;
    }
    if (streamRef.current) {
      streamRef.current.getTracks().forEach((t) => t.stop());
      streamRef.current = null;
    }
    if (videoRef.current) {
      videoRef.current.srcObject = null;
    }
    if (landmarkerRef.current) {
      try { landmarkerRef.current.close?.(); } catch { /* ignore */ }
      landmarkerRef.current = null;
    }
  }, []);

  // Clean up on unmount in case the component is torn down mid-capture.
  useEffect(() => () => stopCapture(), [stopCapture]);

  /** One rAF tick: draw frame → detect landmarks → collect EAR. */
  const tick = useCallback((now: number) => {
    const video = videoRef.current;
    const canvas = canvasRef.current;
    const landmarker = landmarkerRef.current;
    if (!video || !canvas || !landmarker || startTimeRef.current === null) return;

    const elapsed = now - startTimeRef.current;
    setProgress(Math.min(100, Math.round((elapsed / CALIBRATION_DURATION_MS) * 100)));

    // Draw the frame to the offscreen canvas purely for landmark detection.
    const w = video.videoWidth || 640;
    const h = video.videoHeight || 480;
    canvas.width = w;
    canvas.height = h;
    const ctx = canvas.getContext("2d");
    if (ctx) {
      ctx.drawImage(video, 0, 0, w, h);
    }

    // Detect landmarks synchronously; clear canvas immediately (privacy).
    let landmarks: readonly Landmark[] = [];
    try {
      landmarks = landmarker.detect(video, now);
    } finally {
      ctx?.clearRect(0, 0, w, h);
    }

    if (landmarks.length > 0) {
      samplesRef.current.push(computeEAR(landmarks));
    }

    if (elapsed >= CALIBRATION_DURATION_MS) {
      // Window complete: derive threshold and finish.
      stopCapture();
      const derived = deriveThreshold(samplesRef.current);
      setResult(derived);
      setProgress(100);
      setPhase("done");
      return;
    }

    rafHandleRef.current = requestAnimationFrame(tick);
  }, [stopCapture]);

  /** Open the webcam, load the landmarker, then start the rAF loop. */
  const startCapture = useCallback(async () => {
    setPhase("capturing");
    setProgress(0);
    samplesRef.current = [];

    // Create or reuse the hidden video + canvas elements.
    if (!videoRef.current) {
      videoRef.current = document.createElement("video");
      videoRef.current.muted = true;
      (videoRef.current as HTMLVideoElement & { playsInline?: boolean }).playsInline = true;
    }
    if (!canvasRef.current) {
      canvasRef.current = document.createElement("canvas");
    }

    // Open the webcam.
    let stream: MediaStream;
    try {
      stream = await navigator.mediaDevices.getUserMedia({ video: true });
    } catch {
      setErrorMsg(
        "Akses kamera ditolak. Anda dapat melewati kalibrasi dan menggunakan nilai default.",
      );
      setPhase("error");
      return;
    }
    streamRef.current = stream;
    videoRef.current.srcObject = stream;
    try {
      await videoRef.current.play();
    } catch {
      /* autoplay restrictions — rAF will still fire */
    }

    // Load the FaceLandmarker (reuses the same factory as the Vision_Pipeline).
    let landmarker: FaceLandmarker;
    try {
      landmarker = await createMediaPipeFaceLandmarker();
    } catch {
      stopCapture();
      setErrorMsg(
        "Tidak dapat memuat FaceLandmarker. Anda dapat melewati kalibrasi dan menggunakan nilai default.",
      );
      setPhase("error");
      return;
    }
    landmarkerRef.current = landmarker;

    startTimeRef.current = performance.now();
    rafHandleRef.current = requestAnimationFrame(tick);
  }, [tick, stopCapture]);

  const handleSkip = useCallback(() => {
    stopCapture();
    onComplete(makeFallbackResult());
  }, [stopCapture, onComplete]);

  const handleProceed = useCallback(() => {
    if (result) onComplete(result);
  }, [result, onComplete]);

  // ── Render ────────────────────────────────────────────────────────────────

  if (phase === "instruction") {
    return (
      <main className="mx-auto flex min-h-screen max-w-3xl flex-col justify-center gap-8 px-6 py-16">
        <section
          aria-labelledby={headingId}
          className="flex flex-col gap-8 rounded-xl border border-neutral-800 bg-neutral-950/60 p-8 shadow-lg"
        >
          <header className="flex flex-col gap-3">
            <p className="text-sm font-medium uppercase tracking-widest text-neutral-400">
              Kalibrasi kamera
            </p>
            <h1 id={headingId} className="text-3xl font-semibold sm:text-4xl">
              Kalibrasi mata
            </h1>
          </header>

          <p className="text-neutral-300">
            Selama <strong className="text-neutral-100">5 detik</strong>,
            kamera akan mengukur rasio aspek mata Anda dalam kondisi istirahat
            sehingga deteksi kedipan dapat dikalibrasi secara personal untuk
            Anda.
          </p>

          <ul className="flex flex-col gap-2 text-sm text-neutral-400">
            <li className="flex items-start gap-2">
              <span aria-hidden="true" className="mt-0.5 text-emerald-400">✓</span>
              Tatap kamera secara alami dengan mata terbuka.
            </li>
            <li className="flex items-start gap-2">
              <span aria-hidden="true" className="mt-0.5 text-emerald-400">✓</span>
              Hindari berkedip secara berlebihan selama jendela 5 detik.
            </li>
            <li className="flex items-start gap-2">
              <span aria-hidden="true" className="mt-0.5 text-emerald-400">✓</span>
              Tidak ada video yang disimpan — hanya nilai numerik skalar per frame.
            </li>
          </ul>

          <div className="flex flex-col gap-4 sm:flex-row-reverse sm:items-center sm:justify-start">
            <button
              type="button"
              onClick={startCapture}
              className="inline-flex items-center justify-center rounded-md bg-neutral-100 px-5 py-3 text-sm font-semibold text-neutral-900 transition hover:bg-white focus:outline-none focus-visible:ring-2 focus-visible:ring-neutral-100 focus-visible:ring-offset-2 focus-visible:ring-offset-neutral-950"
            >
              Mulai kalibrasi
            </button>
            <button
              type="button"
              onClick={handleSkip}
              className="inline-flex items-center justify-center rounded-md border border-neutral-700 px-5 py-3 text-sm font-semibold text-neutral-200 transition hover:bg-neutral-800 focus:outline-none focus-visible:ring-2 focus-visible:ring-neutral-400 focus-visible:ring-offset-2 focus-visible:ring-offset-neutral-950"
            >
              Lewati kalibrasi
            </button>
          </div>

          <p className="text-sm text-neutral-500">
            Melewati kalibrasi akan menggunakan ambang batas deteksi kedipan
            default ({DEFAULT_BLINK_THRESHOLD}) untuk semua skenario.
          </p>
        </section>
      </main>
    );
  }

  if (phase === "capturing") {
    return (
      <main className="mx-auto flex min-h-screen max-w-3xl flex-col justify-center gap-8 px-6 py-16">
        <section
          role="status"
          aria-live="polite"
          aria-labelledby={headingId}
          className="flex flex-col gap-6 rounded-xl border border-neutral-800 bg-neutral-950/60 p-8 shadow-lg"
        >
          <header className="flex flex-col gap-2">
            <p className="text-sm font-medium uppercase tracking-widest text-neutral-400">
              Kalibrasi kamera
            </p>
            <h1 id={headingId} className="text-3xl font-semibold">
              Tetap tatap kamera…
            </h1>
          </header>

          <p className="text-neutral-300">
            Mengukur rasio aspek mata istirahat Anda. Jaga mata tetap terbuka
            dan tatap langsung ke kamera.
          </p>

          {/* Progress bar */}
          <div className="flex flex-col gap-2">
            <div
              role="progressbar"
              aria-valuenow={progress}
              aria-valuemin={0}
              aria-valuemax={100}
              aria-label="Kemajuan kalibrasi"
              className="h-3 w-full overflow-hidden rounded-full bg-neutral-800"
            >
              <div
                className="h-full rounded-full bg-neutral-100 transition-all duration-200"
                style={{ width: `${progress}%` }}
              />
            </div>
            <p className="text-right text-sm tabular-nums text-neutral-500">
              {progress}%
            </p>
          </div>

          <p className="text-sm text-neutral-500">
            Sampel terkumpul: {samplesRef.current.length}
          </p>
        </section>
      </main>
    );
  }

  if (phase === "done" && result) {
    return (
      <main className="mx-auto flex min-h-screen max-w-3xl flex-col justify-center gap-8 px-6 py-16">
        <section
          aria-labelledby={headingId}
          className="flex flex-col gap-6 rounded-xl border border-neutral-800 bg-neutral-950/60 p-8 shadow-lg"
        >
          <header className="flex flex-col gap-2">
            <p className="text-sm font-medium uppercase tracking-widest text-neutral-400">
              Kalibrasi kamera
            </p>
            <h1 id={headingId} className="text-3xl font-semibold text-emerald-300">
              Kalibrasi selesai
            </h1>
          </header>

          {result.usedFallback ? (
            <p className="text-neutral-300">
              Tidak cukup sampel wajah yang dikumpulkan. Ambang batas default (
              {DEFAULT_BLINK_THRESHOLD}) akan digunakan.
            </p>
          ) : (
            <div className="flex flex-col gap-3">
              <p className="text-neutral-300">
                Ambang batas deteksi kedipan personal Anda telah ditetapkan.
              </p>
              <dl className="grid grid-cols-[auto_1fr] gap-x-6 gap-y-2 rounded-lg border border-neutral-700 bg-neutral-900 px-4 py-4 text-sm">
                <dt className="text-neutral-400">EAR istirahat rata-rata</dt>
                <dd className="tabular-nums text-neutral-100">
                  {result.meanRestingEar.toFixed(3)}
                </dd>
                <dt className="text-neutral-400">Ambang batas personal</dt>
                <dd className="tabular-nums text-neutral-100">
                  {result.threshold.toFixed(3)}
                </dd>
                <dt className="text-neutral-400">Sampel yang digunakan</dt>
                <dd className="tabular-nums text-neutral-100">
                  {result.sampleCount}
                </dd>
              </dl>
            </div>
          )}

          <button
            type="button"
            onClick={handleProceed}
            className="inline-flex w-fit items-center justify-center rounded-md bg-neutral-100 px-5 py-3 text-sm font-semibold text-neutral-900 transition hover:bg-white focus:outline-none focus-visible:ring-2 focus-visible:ring-neutral-100 focus-visible:ring-offset-2 focus-visible:ring-offset-neutral-950"
          >
            Lanjutkan ke studi
          </button>
        </section>
      </main>
    );
  }

  // phase === "error"
  return (
    <main className="mx-auto flex min-h-screen max-w-3xl flex-col justify-center gap-8 px-6 py-16">
      <section
        role="alert"
        aria-labelledby={headingId}
        className="flex flex-col gap-6 rounded-xl border border-amber-900/60 bg-amber-950/30 p-8 shadow-lg"
      >
        <header className="flex flex-col gap-2">
          <p className="text-sm font-medium uppercase tracking-widest text-amber-400">
            Kalibrasi kamera
          </p>
          <h1 id={headingId} className="text-3xl font-semibold text-amber-200">
            Kalibrasi tidak dapat diselesaikan
          </h1>
        </header>

        <p className="text-amber-100/90">
          {errorMsg ?? "Terjadi kesalahan selama kalibrasi."}
        </p>

        <p className="text-sm text-amber-200/70">
          Studi dapat dilanjutkan menggunakan ambang batas default (
          {DEFAULT_BLINK_THRESHOLD}). Deteksi kedipan mungkin kurang akurat
          untuk Anda.
        </p>

        <div className="flex flex-col gap-4 sm:flex-row sm:items-center">
          <button
            type="button"
            onClick={() => {
              setErrorMsg(null);
              setPhase("instruction");
            }}
            className="inline-flex items-center justify-center rounded-md bg-neutral-100 px-5 py-3 text-sm font-semibold text-neutral-900 transition hover:bg-white focus:outline-none focus-visible:ring-2 focus-visible:ring-neutral-100 focus-visible:ring-offset-2 focus-visible:ring-offset-neutral-950"
          >
            Coba lagi
          </button>
          <button
            type="button"
            onClick={handleSkip}
            className="inline-flex items-center justify-center rounded-md border border-neutral-700 px-5 py-3 text-sm font-semibold text-neutral-200 transition hover:bg-neutral-800 focus:outline-none focus-visible:ring-2 focus-visible:ring-neutral-400 focus-visible:ring-offset-2 focus-visible:ring-offset-neutral-950"
          >
            Lanjutkan dengan nilai default
          </button>
        </div>
      </section>
    </main>
  );
}
