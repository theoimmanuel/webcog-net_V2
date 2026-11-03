"use client";

/**
 * `/study` — the Consent_Screen entry point for a Study_Session (Req 2),
 * followed by the EAR calibration step.
 *
 * Flow:
 *  1. ConsentScreen  →  handleConsent() calls grantConsent() + sets phase="calibration"
 *  2. CalibrationStep  →  handleCalibrationComplete() stores the threshold,
 *     sets phase="navigating", then the effect pushes to /study/run
 *  3. (declined)  →  show ended-session message, no webcam ever requested
 *
 * The calibration step is inserted HERE (not in the run page) so the threshold
 * is stored in the provider before getVisionPipeline() is ever called for
 * Scenario C. Because getVisionPipeline() caches on first call, the threshold
 * must be finalised before that first call — and inserting calibration here,
 * between consent and the run flow, guarantees that ordering.
 */

import { useEffect, useState } from "react";
import { useRouter } from "next/navigation";
import ConsentScreen from "@/app/components/consent/ConsentScreen";
import CalibrationStep from "@/app/components/calibration/CalibrationStep";
import { useStudy } from "@/app/components/study/StudyProvider";
import type { CalibrationResult } from "@/lib/vision/calibration";

type StudyPagePhase = "consent" | "calibration" | "navigating";

export default function StudyPage() {
  const router = useRouter();
  const { ready, consentGranted, order, error, grantConsent, setBlinkThreshold } =
    useStudy();
  const [declined, setDeclined] = useState(false);
  const [phase, setPhase] = useState<StudyPagePhase>("consent");

  // Navigate to /study/run once we are in the "navigating" phase and the
  // provider has finished recording consent + order (no error).
  useEffect(() => {
    if (phase === "navigating" && consentGranted && order && !error) {
      router.push("/study/run");
    }
  }, [phase, consentGranted, order, error, router]);

  function handleConsent(timestamp: string) {
    grantConsent(timestamp);
    setPhase("calibration");
  }

  function handleDecline() {
    setDeclined(true);
  }

  function handleCalibrationComplete(result: CalibrationResult) {
    setBlinkThreshold(result);
    setPhase("navigating");
  }

  // ── Declined ──────────────────────────────────────────────────────────────
  if (declined) {
    return (
      <main className="mx-auto flex min-h-screen max-w-3xl flex-col justify-center gap-6 px-6 py-16">
        <section
          role="status"
          aria-live="polite"
          className="flex flex-col gap-4 rounded-xl border border-neutral-800 bg-neutral-950/60 p-8 text-center shadow-lg"
        >
          <h1 className="text-2xl font-semibold text-neutral-100">
            Sesi berakhir
          </h1>
          <p className="text-neutral-300">
            Anda menolak untuk berpartisipasi, sehingga sesi studi telah
            berakhir. Tidak ada akses kamera yang diminta dan tidak ada data
            yang dikumpulkan. Anda dapat menutup tab ini, atau kembali ke awal
            jika Anda berubah pikiran.
          </p>
        </section>
      </main>
    );
  }

  // ── Provider / session-start error ────────────────────────────────────────
  if (error) {
    return (
      <main className="mx-auto flex min-h-screen max-w-3xl flex-col justify-center gap-6 px-6 py-16">
        <section
          role="alert"
          className="flex flex-col gap-4 rounded-xl border border-red-900/60 bg-red-950/40 p-8 text-center shadow-lg"
        >
          <h1 className="text-2xl font-semibold text-red-100">
            Tidak dapat memulai studi
          </h1>
          <p className="text-red-100/90">{error}</p>
        </section>
      </main>
    );
  }

  // ── Calibration step ──────────────────────────────────────────────────────
  if (phase === "calibration") {
    return <CalibrationStep onComplete={handleCalibrationComplete} />;
  }

  // ── Transitioning to /study/run ───────────────────────────────────────────
  if (phase === "navigating") {
    return (
      <main className="mx-auto flex min-h-screen max-w-3xl flex-col justify-center gap-4 px-6 py-16">
        <section
          role="status"
          aria-live="polite"
          className="flex flex-col gap-3 rounded-xl border border-neutral-800 bg-neutral-950/60 p-8 text-center shadow-lg"
        >
          <h1 className="text-2xl font-semibold text-neutral-100">
            Mempersiapkan studi
          </h1>
          <p className="text-neutral-300">Menyiapkan skenario pertama…</p>
        </section>
      </main>
    );
  }

  // ── Consent screen (default / SSR shell) ─────────────────────────────────
  void ready;
  return <ConsentScreen onConsent={handleConsent} onDecline={handleDecline} />;
}
