"use client";

/**
 * `/study` layout — wraps the entire study flow in the Experiment_Harness
 * context and an error boundary (task 21.1, design "study/layout.tsx: Wraps
 * StudyProvider + harness guard").
 *
 * The {@link StudyProvider} owns the Study_Session, the shared source
 * controller + simulated trigger, and the lazy webcam pipeline, and installs
 * the privacy network guard once on mount (Req 1.6) — so mounting it here means
 * the guard and the session span consent (`/study`), the run
 * (`/study/run`), and export (`/study/export`).
 *
 * The {@link StudyErrorBoundary} wraps the children so any error in the flow
 * stops the webcam track (via the provider's `stopVision`) while preserving the
 * in-memory session. A thin bridge reads `stopVision` from context and feeds it
 * to the boundary, keeping the boundary decoupled from the provider.
 */

import type { ReactNode } from "react";
import StudyProvider, { useStudy } from "@/app/components/study/StudyProvider";
import StudyErrorBoundary from "@/app/components/study/StudyErrorBoundary";

/**
 * Bridges the provider's `stopVision` into the error boundary. Must render
 * inside {@link StudyProvider} so `useStudy()` resolves.
 */
function HarnessBoundary({ children }: { children: ReactNode }) {
  const { stopVision } = useStudy();
  return (
    <StudyErrorBoundary onError={() => stopVision()}>
      {children}
    </StudyErrorBoundary>
  );
}

export default function StudyLayout({ children }: { children: ReactNode }) {
  return (
    <StudyProvider>
      <HarnessBoundary>{children}</HarnessBoundary>
    </StudyProvider>
  );
}
