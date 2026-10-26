"use client";

/**
 * StudyErrorBoundary — a React error boundary around the study run flow
 * (task 21.1, design §Experiment Harness).
 *
 * When a render/lifecycle error escapes the harness, the boundary must:
 *  - STOP the webcam track so the camera light goes off immediately (Req 2.6);
 *  - PRESERVE the in-memory Study_Session — it never clears the SessionStore,
 *    so already-collected records survive the error;
 *  - show a friendly, accessible error state rather than a blank screen.
 *
 * Error boundaries must be class components. The webcam-stop side effect is
 * injected via the `onError` prop so the boundary stays decoupled from the
 * StudyProvider: the layout passes `stopVision` from the context.
 */

import { Component, type ErrorInfo, type ReactNode } from "react";

export interface StudyErrorBoundaryProps {
  children: ReactNode;
  /**
   * Invoked once when an error is caught. The layout wires this to the
   * provider's `stopVision` so the webcam track is stopped while the in-memory
   * session is preserved.
   */
  onError?: (error: Error, info: ErrorInfo) => void;
}

interface StudyErrorBoundaryState {
  hasError: boolean;
}

export class StudyErrorBoundary extends Component<
  StudyErrorBoundaryProps,
  StudyErrorBoundaryState
> {
  constructor(props: StudyErrorBoundaryProps) {
    super(props);
    this.state = { hasError: false };
  }

  static getDerivedStateFromError(): StudyErrorBoundaryState {
    return { hasError: true };
  }

  componentDidCatch(error: Error, info: ErrorInfo): void {
    // Stop the webcam track and preserve the in-memory session. The session
    // store is owned by the provider and is deliberately NOT cleared here.
    this.props.onError?.(error, info);
  }

  render(): ReactNode {
    if (this.state.hasError) {
      return (
        <main className="mx-auto flex min-h-screen max-w-3xl flex-col justify-center gap-6 px-6 py-16">
          <section
            role="alert"
            className="flex flex-col gap-4 rounded-xl border border-red-900/60 bg-red-950/40 p-8 text-center shadow-lg"
          >
            <h1 className="text-2xl font-semibold text-red-100">
              Something went wrong
            </h1>
            <p className="text-red-100/90">
              The study hit an unexpected error. Your webcam has been turned off
              and the data collected so far is kept safely in this browser
              session. You can reload the page to continue the export.
            </p>
          </section>
        </main>
      );
    }
    return this.props.children;
  }
}

export default StudyErrorBoundary;
