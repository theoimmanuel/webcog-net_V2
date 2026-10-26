"use client";

/**
 * StudyProvider — the Experiment_Harness context that owns a Study_Session and
 * the cognitive-load plumbing for the whole study flow (task 21.1, design
 * §Experiment Harness, Req 2, 5, 11, 12).
 *
 * It is the single owner of:
 *  - a {@link SessionStore} (participant + session ids generated once, the
 *    source of truth for consent, scenario order, and per-scenario records);
 *  - the session {@link SessionEpoch} shared by every {@link ScenarioTimer}
 *    (Req 11.1);
 *  - the {@link LoadSourceController} that downstream (Scenario C's HUD +
 *    intervention engine) subscribes to (Req 5.2);
 *  - the {@link SimulatedTrigger} backing the HUD controls and the webcam →
 *    simulated fallback (Req 5.1, 3.7);
 *  - lazily, the webcam {@link WebcamVisionPipeline} created only when Scenario
 *    C is reached and only after consent (Req 2.1, 2.3).
 *
 * It installs the privacy network guard once on mount and uninstalls it on
 * unmount (Req 1.6) — mounting here means the guard is active for the entire
 * study flow (which `app/study/layout.tsx` wraps).
 *
 * SSR-safe: `crypto.randomUUID()` and the `SessionStore` (which touches
 * `sessionStorage`) and the network guard are only created inside effects /
 * lazy initialisers that run in the browser. The first render yields a
 * not-ready context so pages can render a neutral shell during SSR / hydration.
 */

import {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useMemo,
  useRef,
  useState,
  type ReactNode,
} from "react";
import {
  SessionStore,
  type ScenarioOrder,
  type ScenarioId,
  type StudyRecord,
  type StudySession,
} from "@/lib/harness/session";
import {
  assignOrder,
  isValidOrder,
  orderKey,
  allOrders,
} from "@/lib/harness/latinSquare";
import {
  createSessionEpoch,
  type SessionEpoch,
} from "@/lib/harness/timing";
import {
  createLoadSourceController,
  type LoadSourceController,
} from "@/lib/load/source";
import {
  createSimulatedTrigger,
  type SimulatedTrigger,
} from "@/lib/load/simulated";
import {
  createVisionPipeline,
  type WebcamVisionPipeline,
} from "@/lib/vision/pipeline";
import { createClassifier, type CnnGruClassifier } from "@/lib/vision/classifier";
import { installNetworkGuard } from "@/lib/privacy/network-guard";

/**
 * The `localStorage` key under which the Latin-Square assignment tally is kept.
 * The tally persists ACROSS sessions (unlike the `sessionStorage` session
 * mirror) so counterbalancing stays balanced within ±1 across participants
 * (Req 12.1). Keyed by `orderKey` (e.g. "ABC").
 */
const TALLY_STORAGE_KEY = "webcog-net:order-tally";

/** The phases of the harness state machine (explicit for testability). */
export type StudyPhase = "consent" | "scenario" | "tlx" | "done" | "error";

/** The value exposed by {@link StudyContext}. */
export interface StudyContextValue {
  /** True once the browser-only store/epoch/controller have been created. */
  ready: boolean;
  /** The current in-memory session snapshot, or null before ready. */
  session: StudySession | null;
  /** The assigned scenario order, or null before the session is started. */
  order: ScenarioOrder | null;
  /** Whether consent has been granted and study-data writes are permitted. */
  consentGranted: boolean;
  /** An error indication to surface (invalid order, webcam denied, ...). */
  error: string | null;
  /** The shared session epoch for scenario timers (Req 11.1). */
  epoch: SessionEpoch | null;
  /** The active-source controller downstream consumers subscribe to (Req 5.2). */
  controller: LoadSourceController | null;
  /** The Simulated_Trigger backing the HUD + fallback (Req 5.1). */
  simulated: SimulatedTrigger | null;

  /**
   * Grant consent (Req 2.3, 2.4) and START the session: assign the scenario
   * order via the balanced Latin-Square tally and record it with the
   * participant/session ids BEFORE the first scenario (Req 12.1, 12.3). An
   * invalid assigned order leaves the session unstarted and sets `error`
   * (Req 12.5).
   */
  grantConsent: (timestamp: string) => void;

  /** Persist a scenario's record exactly once (Req 11.6). */
  setRecord: (scenario: ScenarioId, record: StudyRecord) => void;

  /** Record the measured model artifact size (Req 4.3). */
  setModelSize: (bytes: number) => void;

  /**
   * Lazily create (once) and return the webcam Vision_Pipeline for Scenario C.
   * Only valid after consent; returns null during SSR / before ready.
   */
  getVisionPipeline: () => WebcamVisionPipeline | null;

  /**
   * The measured model-artifact size in bytes from the classifier the webcam
   * pipeline uses (Req 4.3), or 0 before it has loaded.
   */
  getModelSizeBytes: () => number;

  /**
   * Stop the webcam pipeline (if any) without clearing the in-memory session.
   * Used by the error boundary and when ending the study on webcam denial.
   */
  stopVision: () => void;

  /**
   * End the study with the "webcam access is required" message when the webcam
   * is denied AFTER consent (Req 2.7). Stops the webcam track and sets `error`.
   */
  endForWebcamDenied: () => void;

  /** Record a generic fatal error, preserving the in-memory session. */
  reportFatalError: (message: string) => void;
}

const StudyContext = createContext<StudyContextValue | null>(null);

/** The message shown when the webcam is denied after consent (Req 2.7). */
export const WEBCAM_REQUIRED_MESSAGE =
  "Webcam access is required to proceed. The study has ended.";

/** The message shown when an assigned scenario order is invalid (Req 12.5). */
export const INVALID_ORDER_MESSAGE =
  "The assigned scenario order was invalid, so the study could not start.";

/** Read the persisted Latin-Square tally from `localStorage` (browser-only). */
function readTally(): Record<string, number> {
  if (typeof window === "undefined") return {};
  try {
    const raw = window.localStorage.getItem(TALLY_STORAGE_KEY);
    if (!raw) return {};
    const parsed: unknown = JSON.parse(raw);
    if (typeof parsed !== "object" || parsed === null) return {};
    const out: Record<string, number> = {};
    for (const o of allOrders()) {
      const key = orderKey(o);
      const value = (parsed as Record<string, unknown>)[key];
      if (typeof value === "number" && Number.isFinite(value) && value > 0) {
        out[key] = value;
      }
    }
    return out;
  } catch {
    return {};
  }
}

/** Increment and persist the tally for the given order (browser-only). */
function bumpTally(order: ScenarioOrder): void {
  if (typeof window === "undefined") return;
  try {
    const tally = readTally();
    const key = orderKey(order);
    tally[key] = (tally[key] ?? 0) + 1;
    window.localStorage.setItem(TALLY_STORAGE_KEY, JSON.stringify(tally));
  } catch {
    // Tally persistence is best-effort; a failure only affects balancing.
  }
}

/** Generate an id using `crypto.randomUUID` when available, else a fallback. */
function generateId(prefix: string): string {
  const c = (globalThis as { crypto?: Crypto }).crypto;
  if (c && typeof c.randomUUID === "function") {
    return `${prefix}-${c.randomUUID()}`;
  }
  // Fallback for environments without crypto.randomUUID.
  return `${prefix}-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 10)}`;
}

export interface StudyProviderProps {
  children: ReactNode;
}

export function StudyProvider({ children }: StudyProviderProps) {
  // Browser-only singletons, created once in an effect after mount so SSR never
  // touches crypto / sessionStorage / the network guard.
  const storeRef = useRef<SessionStore | null>(null);
  const epochRef = useRef<SessionEpoch | null>(null);
  const controllerRef = useRef<LoadSourceController | null>(null);
  const simulatedRef = useRef<SimulatedTrigger | null>(null);
  const pipelineRef = useRef<WebcamVisionPipeline | null>(null);
  // The classifier backing the webcam pipeline. Owned here so model size can be
  // read after Scenario C runs (Req 4.3).
  const classifierRef = useRef<CnnGruClassifier | null>(null);

  const [ready, setReady] = useState(false);
  const [session, setSession] = useState<StudySession | null>(null);
  const [error, setError] = useState<string | null>(null);

  // Mount: install the network guard, build the store + epoch + controller +
  // simulated trigger, and start the simulated source so the controller always
  // has an active, DOM-free source. Tear everything down on unmount.
  useEffect(() => {
    const uninstallGuard = installNetworkGuard();

    const participantId = generateId("participant");
    const sessionId = generateId("session");
    const store = new SessionStore({ participantId, sessionId });
    const epoch = createSessionEpoch();
    const controller = createLoadSourceController();
    const simulated = createSimulatedTrigger({ initialState: "LOW" });

    // The simulated source is the default active source. Scenario C may later
    // switch the controller to the webcam pipeline; the webcam → simulated
    // fallback (Req 3.7) switches back here.
    controller.setActiveSource(simulated);
    void simulated.start();

    storeRef.current = store;
    epochRef.current = epoch;
    controllerRef.current = controller;
    simulatedRef.current = simulated;

    setSession(store.getSession());
    setReady(true);

    return () => {
      pipelineRef.current?.stop();
      pipelineRef.current = null;
      controller.dispose();
      simulated.stop();
      uninstallGuard();
    };
  }, []);

  /** Refresh the session snapshot from the store after any write. */
  const refresh = useCallback(() => {
    if (storeRef.current) {
      setSession(storeRef.current.getSession());
    }
  }, []);

  const grantConsent = useCallback(
    (timestamp: string) => {
      const store = storeRef.current;
      if (!store) return;

      // Grant consent first so the gated writes below are permitted (Req 2.3).
      store.grantConsent(timestamp);

      // SESSION START: assign the counterbalanced order from the persisted
      // tally (Req 12.1) and record it with participant/session ids BEFORE the
      // first scenario is presented (Req 12.3).
      const tally = readTally();
      const assigned = assignOrder(tally);

      // Validate the assigned order; an invalid order leaves the session
      // unstarted and surfaces an error (Req 12.5).
      if (!isValidOrder([...assigned])) {
        setError(INVALID_ORDER_MESSAGE);
        refresh();
        return;
      }

      const recorded = store.setScenarioOrder(assigned);
      if (!recorded) {
        setError(INVALID_ORDER_MESSAGE);
        refresh();
        return;
      }

      // Only bump the shared tally once the order is actually committed, so a
      // rejected assignment never skews future counterbalancing.
      bumpTally(assigned);
      setError(null);
      refresh();
    },
    [refresh],
  );

  const setRecord = useCallback(
    (scenario: ScenarioId, record: StudyRecord) => {
      storeRef.current?.setRecord(scenario, record);
      refresh();
    },
    [refresh],
  );

  const setModelSize = useCallback(
    (bytes: number) => {
      storeRef.current?.setModelSize(bytes);
      refresh();
    },
    [refresh],
  );

  const stopVision = useCallback(() => {
    pipelineRef.current?.stop();
  }, []);

  const getVisionPipeline = useCallback((): WebcamVisionPipeline | null => {
    if (!ready || typeof window === "undefined") return null;
    if (pipelineRef.current) return pipelineRef.current;
    // Own the classifier so its measured size can be read after it loads
    // (Req 4.3), and inject it into the pipeline.
    const classifier = createClassifier();
    classifierRef.current = classifier;
    // Create the webcam pipeline lazily (Scenario C only, after consent). It is
    // not started here — the caller starts it so denial handling is explicit.
    const pipeline = createVisionPipeline({
      classifier,
      onFallbackToSimulated: () => {
        // Sustained face loss falls back to simulated (Req 3.7); explicit
        // denial is handled separately via endForWebcamDenied (Req 2.7).
        const controller = controllerRef.current;
        const simulated = simulatedRef.current;
        if (controller && simulated) {
          controller.fallbackToSimulated(simulated);
        }
      },
    });
    pipelineRef.current = pipeline;
    return pipeline;
  }, [ready]);

  const getModelSizeBytes = useCallback((): number => {
    const classifier = classifierRef.current;
    if (!classifier) return 0;
    try {
      return classifier.modelSizeBytes();
    } catch {
      return 0;
    }
  }, []);

  const endForWebcamDenied = useCallback(() => {
    pipelineRef.current?.stop();
    // Return the controller to the simulated source so nothing dangles.
    const controller = controllerRef.current;
    const simulated = simulatedRef.current;
    if (controller && simulated) {
      controller.setActiveSource(simulated);
    }
    setError(WEBCAM_REQUIRED_MESSAGE);
  }, []);

  const reportFatalError = useCallback((message: string) => {
    // Preserve the in-memory session: stop only the webcam track (Req 2.6) and
    // surface the error. The store is never cleared.
    pipelineRef.current?.stop();
    setError(message);
  }, []);

  const value = useMemo<StudyContextValue>(
    () => ({
      ready,
      session,
      order: session?.scenarioOrder ?? null,
      consentGranted: session?.consentGranted ?? false,
      error,
      epoch: epochRef.current,
      controller: controllerRef.current,
      simulated: simulatedRef.current,
      grantConsent,
      setRecord,
      setModelSize,
      getVisionPipeline,
      getModelSizeBytes,
      stopVision,
      endForWebcamDenied,
      reportFatalError,
    }),
    [
      ready,
      session,
      error,
      grantConsent,
      setRecord,
      setModelSize,
      getVisionPipeline,
      getModelSizeBytes,
      stopVision,
      endForWebcamDenied,
      reportFatalError,
    ],
  );

  return <StudyContext.Provider value={value}>{children}</StudyContext.Provider>;
}

/**
 * Access the study context. Throws when used outside {@link StudyProvider} so a
 * misplacement is caught immediately in development.
 */
export function useStudy(): StudyContextValue {
  const ctx = useContext(StudyContext);
  if (ctx === null) {
    throw new Error("useStudy() must be used within a <StudyProvider>.");
  }
  return ctx;
}

export default StudyProvider;
