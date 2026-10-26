"use client";

/**
 * `/study/run` — the HarnessController (task 21.1, design §HarnessController,
 * Req 11, 12, 13, 2.7).
 *
 * Drives the within-subjects flow with an explicit state machine:
 *
 *   phase: "scenario" ──BookingTask onComplete──▶ "tlx" ──NasaTlx onSubmit──▶
 *          (write StudyRecord, advance index) ──▶ "scenario" | "done" | "error"
 *
 * Guarantees (the key behaviours for integration test 21.2):
 *  - each of the three scenarios is presented EXACTLY ONCE, in the assigned
 *    order (Req 12.2, 12.4). The order was already assigned + recorded with the
 *    participant/session ids by the provider's `grantConsent`, BEFORE this page
 *    presents the first scenario (Req 12.3);
 *  - a {@link ScenarioTimer} is started on each scenario's first presentation
 *    (Req 11.1) and completed when its BookingTask reaches confirmation
 *    (Req 11.2);
 *  - NASA-TLX for a scenario is presented AFTER its BookingTask and BEFORE
 *    advancing (Req 13.1); on submit the full StudyRecord (timing + tlx +
 *    latency + interventionApplied) is written exactly once (Req 11.6) and the
 *    flow advances;
 *  - after the last scenario + TLX, it navigates to `/study/export`.
 *
 * Scenario C webcam handling (Req 2.7): when Scenario C is presented, the lazy
 * webcam Vision_Pipeline is started (consent is already granted). If the webcam
 * is DENIED after consent, the study ENDS with the "webcam access is required"
 * message. Per-inference latency is collected (warmup excluded) into a
 * {@link LatencyAccumulator} and stored in the Scenario C record, and the
 * classifier's model size is recorded.
 */

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { useRouter } from "next/navigation";
import { useStudy } from "@/app/components/study/StudyProvider";
import ScenarioA from "@/app/components/scenarios/ScenarioA";
import ScenarioB from "@/app/components/scenarios/ScenarioB";
import ScenarioC from "@/app/components/scenarios/ScenarioC";
import NasaTlx from "@/app/components/tlx/NasaTlx";
import { ScenarioTimer, type TimingResult } from "@/lib/harness/timing";
import type {
  NasaTlxScores,
  ScenarioId,
  StudyRecord,
} from "@/lib/harness/session";
import { LatencyAccumulator } from "@/lib/vision/latency";
import type { LoadSample } from "@/lib/load/source";
import { SustainedHighDetector } from "@/lib/load/sustain";

/** The explicit phases the controller moves through. */
type RunPhase = "scenario" | "tlx" | "done";

export default function HarnessRunPage() {
  const router = useRouter();
  const {
    ready,
    order,
    consentGranted,
    error,
    epoch,
    controller,
    simulated,
    setRecord,
    setModelSize,
    getVisionPipeline,
    getModelSizeBytes,
    endForWebcamDenied,
  } = useStudy();

  // Index into the assigned order and the current phase (Req 12.2).
  const [index, setIndex] = useState(0);
  const [phase, setPhase] = useState<RunPhase>("scenario");

  // One ScenarioTimer per scenario, created lazily on first presentation so
  // exactly one start/completion is recorded per scenario (Req 11.1, 11.6).
  const timersRef = useRef<Partial<Record<ScenarioId, ScenarioTimer>>>({});
  // The timing result captured at BookingTask completion, carried into the TLX
  // submit so the written record reflects the completion that just happened.
  const timingRef = useRef<TimingResult | null>(null);

  // Scenario C telemetry: latency accumulator + whether an intervention was
  // applied. Reset per Scenario C presentation.
  const latencyRef = useRef<LatencyAccumulator>(new LatencyAccumulator());
  const interventionRef = useRef(false);

  const current: ScenarioId | null = order ? order[index] ?? null : null;

  /** Get or create the timer for a scenario (first call starts it, Req 11.1). */
  const timerFor = useCallback(
    (scenario: ScenarioId): ScenarioTimer | null => {
      if (!epoch) return null;
      let timer = timersRef.current[scenario];
      if (!timer) {
        timer = new ScenarioTimer(scenario, epoch);
        timersRef.current[scenario] = timer;
      }
      return timer;
    },
    [epoch],
  );

  // Start the timer for the current scenario on first presentation (Req 11.1).
  useEffect(() => {
    if (phase !== "scenario" || !current) return;
    timerFor(current)?.start();
  }, [phase, current, timerFor]);

  // --- Scenario C webcam + latency wiring (Req 2.7, 4.3, 4.4) ---------------
  //
  // When Scenario C is the current scenario, start the webcam pipeline, point
  // the controller at it, collect per-inference latency, and end the study on
  // webcam denial. Everything is torn down when C is left or on unmount.
  useEffect(() => {
    if (phase !== "scenario" || current !== "C" || !ready) return;
    if (!controller || !simulated) return;

    const pipeline = getVisionPipeline();
    if (!pipeline) return;

    // Fresh telemetry for this Scenario C presentation.
    latencyRef.current = new LatencyAccumulator();
    interventionRef.current = false;

    // Mirror ScenarioC's own intervention trigger: a sustained HIGH run is
    // exactly when its engine decluttered, so this records interventionApplied
    // for the StudyRecord without reaching into ScenarioC's internals.
    const sustain = new SustainedHighDetector();

    let cancelled = false;

    const unsubscribeSamples = pipeline.subscribe((sample: LoadSample) => {
      // Each emitted sample carries the inference latency; warmup is excluded
      // by the classifier (never fed here), so every sample is an included one.
      latencyRef.current.add(sample.latencyMs);
      if (sustain.update(sample.state, sample.timestamp)) {
        interventionRef.current = true;
      }
    });

    const unsubscribeErrors = pipeline.onError(() => {
      // Webcam denied/unavailable AFTER consent ends the study (Req 2.7).
      if (!cancelled) {
        endForWebcamDenied();
      }
    });

    // Make the webcam pipeline the active source (Req 5.2), then start it.
    controller.setActiveSource(pipeline);
    pipeline.start().catch(() => {
      // start() rejects with WebcamUnavailableError on denial; the onError
      // listener above already ends the study (Req 2.7). Nothing more here.
    });

    return () => {
      cancelled = true;
      unsubscribeSamples();
      unsubscribeErrors();
      pipeline.stop();
      // Return the controller to the simulated source so Scenario C's own HUD
      // (which it also drives) and the fallback stay coherent.
      controller.setActiveSource(simulated);
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [phase, current, ready]);

  // When all scenarios are done, navigate to the export route.
  useEffect(() => {
    if (phase === "done") {
      router.push("/study/export");
    }
  }, [phase, router]);

  /** BookingTask reached confirmation: stop the timer, present TLX (Req 13.1). */
  const handleScenarioComplete = useCallback(() => {
    if (!current) return;
    const timer = timerFor(current);
    timer?.complete();
    timingRef.current = timer?.result() ?? null;
    setPhase("tlx");
  }, [current, timerFor]);

  /** Participant abandoned the booking task before confirmation (Req 11.4). */
  const handleScenarioAbandon = useCallback(() => {
    if (!current) return;
    const timer = timerFor(current);
    timer?.abandon();
    timingRef.current = timer?.result() ?? null;
    setPhase("tlx");
  }, [current, timerFor]);

  /**
   * NASA-TLX submitted: write the single StudyRecord for this scenario
   * (Req 11.6) with timing + tlx + latency + interventionApplied, then advance
   * to the next scenario or finish (Req 13.1, 12.2).
   */
  const handleTlxSubmit = useCallback(
    (tlx: NasaTlxScores) => {
      if (!current) return;

      const timing: TimingResult = timingRef.current ??
        timerFor(current)?.result() ?? {
          startTimestamp: null,
          completionTimestamp: null,
          taskCompletionTimeMs: null,
          status: "invalid",
        };

      const isC = current === "C";
      const latency = isC ? latencyRef.current.stats() : null;

      const record: StudyRecord = {
        scenario: current,
        status: timing.status,
        startTimestamp: timing.startTimestamp,
        completionTimestamp: timing.completionTimestamp,
        taskCompletionTimeMs: timing.taskCompletionTimeMs,
        tlx,
        latency,
        interventionApplied: isC ? interventionRef.current : false,
      };

      setRecord(current, record);

      // Record Scenario C's measured model size now that it has run (Req 4.3).
      if (isC) {
        const bytes = getModelSizeBytes();
        if (bytes > 0) setModelSize(bytes);
      }

      timingRef.current = null;

      // Advance exactly once per scenario (Req 12.2, 12.4).
      const next = index + 1;
      if (order && next < order.length) {
        setIndex(next);
        setPhase("scenario");
      } else {
        setPhase("done");
      }
    },
    [
      current,
      index,
      order,
      timerFor,
      setRecord,
      setModelSize,
      getModelSizeBytes,
    ],
  );

  // --- Render ---------------------------------------------------------------

  // Provider error (invalid order from session start, or webcam denied after
  // consent, Req 2.7, 12.5) takes precedence over the flow.
  if (error) {
    return (
      <main className="mx-auto flex min-h-screen max-w-3xl flex-col justify-center gap-6 px-6 py-16">
        <section
          role="alert"
          className="flex flex-col gap-4 rounded-xl border border-red-900/60 bg-red-950/40 p-8 text-center shadow-lg"
        >
          <h1 className="text-2xl font-semibold text-red-100">
            The study has ended
          </h1>
          <p className="text-red-100/90">{error}</p>
        </section>
      </main>
    );
  }

  // Not ready, no consent, or no order yet: show a neutral loading shell. This
  // also covers direct navigation to /study/run without starting at /study.
  if (!ready || !consentGranted || !order) {
    return (
      <main className="mx-auto flex min-h-screen max-w-3xl flex-col justify-center gap-4 px-6 py-16">
        <section
          role="status"
          aria-live="polite"
          className="flex flex-col gap-3 rounded-xl border border-neutral-800 bg-neutral-950/60 p-8 text-center shadow-lg"
        >
          <h1 className="text-2xl font-semibold text-neutral-100">
            Preparing the study
          </h1>
          <p className="text-neutral-300">
            {consentGranted
              ? "Setting up the first scenario…"
              : "Please start from the consent screen to begin."}
          </p>
        </section>
      </main>
    );
  }

  if (phase === "done") {
    return (
      <main className="mx-auto flex min-h-screen max-w-3xl flex-col justify-center gap-4 px-6 py-16">
        <section
          role="status"
          aria-live="polite"
          className="flex flex-col gap-3 rounded-xl border border-neutral-800 bg-neutral-950/60 p-8 text-center shadow-lg"
        >
          <h1 className="text-2xl font-semibold text-neutral-100">
            All scenarios complete
          </h1>
          <p className="text-neutral-300">Taking you to the data export…</p>
        </section>
      </main>
    );
  }

  if (phase === "tlx" && current) {
    return <NasaTlx scenario={current} onSubmit={handleTlxSubmit} />;
  }

  // phase === "scenario": render the current scenario exactly once.
  if (current === "A") {
    return (
      <ScenarioA
        onComplete={handleScenarioComplete}
        onAbandon={handleScenarioAbandon}
      />
    );
  }
  if (current === "B") {
    return (
      <ScenarioB
        onComplete={handleScenarioComplete}
        onAbandon={handleScenarioAbandon}
      />
    );
  }
  if (current === "C") {
    return (
      <ScenarioC
        onComplete={handleScenarioComplete}
        onAbandon={handleScenarioAbandon}
        controller={controller ?? undefined}
        simulated={simulated ?? undefined}
      />
    );
  }

  return null;
}
