"use client";

/**
 * `/study` — the Consent_Screen entry point for a Study_Session (Req 2).
 *
 * Consent is now owned by the {@link StudyProvider} (task 21.1): this page
 * renders {@link ConsentScreen} and routes its two outcomes through the
 * provider so the SessionStore records the ISO 8601 UTC consent timestamp and
 * assigns + records the scenario order BEFORE the first scenario (Req 2.3, 2.4,
 * 12.3). The provider is mounted by `app/study/layout.tsx`, so this page always
 * has access to it.
 *
 *  - GRANT: call `grantConsent(timestamp)` (which starts the session) and
 *    navigate into the run flow at `/study/run`, well within the 2-second
 *    budget (Req 2.4). Nothing here touches the webcam.
 *  - DECLINE: end the session locally and show the ended-session confirmation;
 *    no webcam access is ever requested (Req 2.5).
 *
 * If the provider surfaces an error during session start (an invalid assigned
 * order, Req 12.5), we show that error instead of navigating.
 */

import { useEffect, useState } from "react";
import { useRouter } from "next/navigation";
import ConsentScreen from "@/app/components/consent/ConsentScreen";
import { useStudy } from "@/app/components/study/StudyProvider";

export default function StudyPage() {
  const router = useRouter();
  const { ready, consentGranted, order, error, grantConsent } = useStudy();
  const [declined, setDeclined] = useState(false);
  const [granting, setGranting] = useState(false);

  // Once consent is granted and the order is recorded (session started), move
  // into the run flow. Guarded by `granting` so navigation only follows an
  // explicit grant from this page, and skipped when an error was surfaced.
  useEffect(() => {
    if (granting && consentGranted && order && !error) {
      router.push("/study/run");
    }
  }, [granting, consentGranted, order, error, router]);

  function handleConsent(timestamp: string) {
    setGranting(true);
    grantConsent(timestamp);
  }

  function handleDecline() {
    // Ending the session is purely local: no webcam was ever requested (Req 2.5).
    setDeclined(true);
  }

  if (declined) {
    return (
      <main className="mx-auto flex min-h-screen max-w-3xl flex-col justify-center gap-6 px-6 py-16">
        <section
          role="status"
          aria-live="polite"
          className="flex flex-col gap-4 rounded-xl border border-neutral-800 bg-neutral-950/60 p-8 text-center shadow-lg"
        >
          <h1 className="text-2xl font-semibold text-neutral-100">
            Session ended
          </h1>
          <p className="text-neutral-300">
            You declined to participate, so the study session has ended. No
            webcam access was requested and no data was collected. You can close
            this tab, or return to the start if you change your mind.
          </p>
        </section>
      </main>
    );
  }

  // Session-start error (e.g. an invalid assigned order, Req 12.5).
  if (error) {
    return (
      <main className="mx-auto flex min-h-screen max-w-3xl flex-col justify-center gap-6 px-6 py-16">
        <section
          role="alert"
          className="flex flex-col gap-4 rounded-xl border border-red-900/60 bg-red-950/40 p-8 text-center shadow-lg"
        >
          <h1 className="text-2xl font-semibold text-red-100">
            Could not start the study
          </h1>
          <p className="text-red-100/90">{error}</p>
        </section>
      </main>
    );
  }

  // Before the provider is ready (SSR / hydration), render the consent screen
  // but disable grant until ready by waiting — ConsentScreen is harmless to
  // render; the grant handler no-ops until the store exists.
  void ready;

  return <ConsentScreen onConsent={handleConsent} onDecline={handleDecline} />;
}
