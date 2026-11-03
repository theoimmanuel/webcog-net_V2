"use client";

/**
 * ConsentScreen — the informed-consent gate for a Study_Session (Req 2).
 *
 * This component is the single gate that must precede any webcam access or
 * study-data collection (Req 2.1, 2.3; design Property 3). It renders the study
 * purpose, the three *processed* signals, and a Privacy-by-Design statement
 * (Req 2.2), and exposes exactly two actions: grant and decline.
 *
 * CRITICAL privacy invariant: this component NEVER calls `getUserMedia`, never
 * touches the webcam, and never imports or starts the vision pipeline. It only
 * exposes the path forward *after* consent is granted — the proceed path is
 * surfaced through the `onConsent` callback, which the harness wires to
 * navigation into the study flow. Decline (`onDecline`) ends the session
 * without ever requesting the webcam (Req 2.5).
 *
 * On grant we stamp the moment in ISO 8601 UTC via `nowConsentTimestamp()`
 * (Req 2.4) and hand that timestamp to the caller so the SessionStore can
 * record it and un-gate writes. The timestamp is produced synchronously so the
 * proceed step happens well within the 2-second budget (Req 2.4).
 */

import { useId, useRef } from "react";
import { nowConsentTimestamp } from "@/lib/export/consent-timestamp";

/** The three *processed* signals disclosed on the consent screen (Req 2.2). */
const PROCESSED_SIGNALS: ReadonlyArray<{ name: string; description: string }> = [
  {
    name: "Eye Aspect Ratio (EAR)",
    description:
      "Rasio tak berdimensi dari jarak landmark mata yang digunakan untuk mengukur keterbukaan mata.",
  },
  {
    name: "Laju Kedip (Blink Rate)",
    description: "Jumlah kedipan yang terdeteksi per menit, diturunkan dari EAR.",
  },
  {
    name: "Kecepatan Sakade (Saccade Velocity)",
    description:
      "Kecepatan sudut gerakan mata cepat, dalam derajat per detik.",
  },
];

export interface ConsentScreenProps {
  /**
   * Called when the participant grants consent, with the ISO 8601 UTC
   * timestamp stamped at the moment of grant (Req 2.4). The owner (the
   * StudyProvider / harness in task 21.1) records this via
   * `SessionStore.grantConsent(timestamp)` and proceeds into the study flow.
   */
  onConsent: (timestamp: string) => void;
  /**
   * Called when the participant declines. The owner ends the Study_Session and
   * must not request webcam access (Req 2.5).
   */
  onDecline: () => void;
}

export default function ConsentScreen({
  onConsent,
  onDecline,
}: ConsentScreenProps) {
  // Guard against double-invocation (e.g. a double click) so consent is only
  // granted/declined once per mount; the SessionStore is also idempotent.
  const resolvedRef = useRef(false);

  const headingId = useId();
  const purposeId = useId();
  const signalsId = useId();
  const privacyId = useId();

  function handleGrant() {
    if (resolvedRef.current) return;
    resolvedRef.current = true;
    // Stamp the exact moment of consent in ISO 8601 UTC (Req 2.4). Synchronous,
    // so proceeding happens immediately — well within the 2-second budget.
    onConsent(nowConsentTimestamp());
  }

  function handleDecline() {
    if (resolvedRef.current) return;
    resolvedRef.current = true;
    onDecline();
  }

  return (
    <main className="mx-auto flex min-h-screen max-w-3xl flex-col justify-center gap-8 px-6 py-16">
      <section
        aria-labelledby={headingId}
        className="flex flex-col gap-8 rounded-xl border border-neutral-800 bg-neutral-950/60 p-8 shadow-lg"
      >
        <header className="flex flex-col gap-3">
          <p className="text-sm font-medium uppercase tracking-widest text-neutral-400">
            Persetujuan yang diinformasikan
          </p>
          <h1 id={headingId} className="text-3xl font-semibold sm:text-4xl">
            Sebelum Anda mulai
          </h1>
        </header>

        <section aria-labelledby={purposeId} className="flex flex-col gap-3">
          <h2
            id={purposeId}
            className="text-lg font-semibold text-neutral-100"
          >
            Tujuan studi
          </h2>
          <p className="text-neutral-300">
            Studi ini menginvestigasi apakah antarmuka web adaptif yang
            menyederhanakan tampilan sebagai respons terhadap beban kognitif
            yang terdeteksi dapat mengurangi beban kerja yang dirasakan dan
            waktu penyelesaian tugas dibandingkan dengan baseline yang tenang
            dan antarmuka dengan banyak gangguan statis. Anda akan menyelesaikan
            tugas pemesanan penerbangan yang sama dalam tiga kondisi antarmuka
            dan menilai beban kerja Anda setelah masing-masing kondisi.
          </p>
        </section>

        <section aria-labelledby={signalsId} className="flex flex-col gap-3">
          <h2
            id={signalsId}
            className="text-lg font-semibold text-neutral-100"
          >
            Yang diukur
          </h2>
          <p className="text-neutral-300">
            Dengan persetujuan Anda, kamera web digunakan untuk menghitung tiga
            sinyal yang telah diproses dari landmark wajah Anda secara real time:
          </p>
          <ul className="flex flex-col gap-3">
            {PROCESSED_SIGNALS.map((signal) => (
              <li
                key={signal.name}
                className="rounded-lg border border-neutral-800 bg-neutral-900/50 p-4"
              >
                <p className="font-medium text-neutral-100">{signal.name}</p>
                <p className="text-sm text-neutral-400">{signal.description}</p>
              </li>
            ))}
          </ul>
        </section>

        <section
          aria-labelledby={privacyId}
          className="flex flex-col gap-3 rounded-lg border border-emerald-900/60 bg-emerald-950/30 p-4"
        >
          <h2
            id={privacyId}
            className="text-lg font-semibold text-emerald-200"
          >
            Privasi sejak desain
          </h2>
          <p className="text-emerald-100/90">
            Semua proses computer vision dan inferensi berjalan sepenuhnya di
            browser Anda. Tidak ada rekaman video mentah dan tidak ada citra
            biometrik yang pernah disimpan atau dikirimkan ke server mana pun.
            Hanya tiga sinyal yang telah diproses di atas dan hasil tugas Anda
            yang disimpan, dan semuanya tetap berada di perangkat ini.
          </p>
        </section>

        <div className="flex flex-col gap-4 sm:flex-row-reverse sm:items-center sm:justify-start">
          <button
            type="button"
            onClick={handleGrant}
            className="inline-flex items-center justify-center rounded-md bg-neutral-100 px-5 py-3 text-sm font-semibold text-neutral-900 transition hover:bg-white focus:outline-none focus-visible:ring-2 focus-visible:ring-neutral-100 focus-visible:ring-offset-2 focus-visible:ring-offset-neutral-950"
          >
            Saya setuju — mulai studi
          </button>
          <button
            type="button"
            onClick={handleDecline}
            className="inline-flex items-center justify-center rounded-md border border-neutral-700 px-5 py-3 text-sm font-semibold text-neutral-200 transition hover:bg-neutral-800 focus:outline-none focus-visible:ring-2 focus-visible:ring-neutral-400 focus-visible:ring-offset-2 focus-visible:ring-offset-neutral-950"
          >
            Tolak
          </button>
        </div>

        <p className="text-sm text-neutral-500">
          Kamera web hanya diminta setelah Anda memberikan persetujuan. Menolak
          mengakhiri sesi dan tidak pernah meminta akses kamera.
        </p>
      </section>
    </main>
  );
}
