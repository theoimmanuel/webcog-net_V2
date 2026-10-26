"use client";

/**
 * Raw NASA-TLX (RTLX) questionnaire presented after each scenario (Req 13).
 *
 * Collects the six workload dimensions — Mental Demand, Physical Demand,
 * Temporal Demand, Performance, Effort, and Frustration (Req 13.2) — each as an
 * integer on a 0–100 scale in increments of 1 (Req 13.3). The Performance
 * dimension is oriented so 0 is the best (perfect) anchor and 100 the worst
 * (failure) anchor; the other dimensions run 0 = low to 100 = high (Req 13.4).
 *
 * Submitting with all six dimensions rated stores the scores and advances via
 * the `onSubmit` prop (Req 13.5). Submitting while any dimension is still
 * unrated blocks submission, lists which dimensions remain, and keeps every
 * entered rating (Req 13.6).
 *
 * "Unrated" is tracked independently of the value so an untouched slider —
 * which still reports a value of 0 — is distinguishable from a deliberate 0
 * rating. Each dimension begins unrated; interacting with its slider or number
 * input marks it rated.
 */

import { useId, useMemo, useState } from "react";
import type { NasaTlxScores, ScenarioId } from "@/lib/harness/session";

/** The six NASA-TLX dimensions, in presentation order (Req 13.2). */
const DIMENSIONS = [
  "mental",
  "physical",
  "temporal",
  "performance",
  "effort",
  "frustration",
] as const;

type DimensionKey = (typeof DIMENSIONS)[number];

interface DimensionDef {
  key: DimensionKey;
  /** Human-readable dimension name shown as the slider label. */
  label: string;
  /** One-line description of what the dimension measures. */
  description: string;
  /** Anchor shown at the 0 end of the scale. */
  lowAnchor: string;
  /** Anchor shown at the 100 end of the scale. */
  highAnchor: string;
}

/**
 * Dimension definitions with their extreme anchors (Req 13.3). The Performance
 * dimension inverts the usual orientation: 0 = best, 100 = worst (Req 13.4).
 */
const DIMENSION_DEFS: readonly DimensionDef[] = [
  {
    key: "mental",
    label: "Mental Demand",
    description: "How mentally demanding was the task?",
    lowAnchor: "Very Low",
    highAnchor: "Very High",
  },
  {
    key: "physical",
    label: "Physical Demand",
    description: "How physically demanding was the task?",
    lowAnchor: "Very Low",
    highAnchor: "Very High",
  },
  {
    key: "temporal",
    label: "Temporal Demand",
    description: "How hurried or rushed was the pace of the task?",
    lowAnchor: "Very Low",
    highAnchor: "Very High",
  },
  {
    key: "performance",
    label: "Performance",
    description:
      "How successful were you in accomplishing what you were asked to do?",
    // Performance is oriented 0 = best, 100 = worst (Req 13.4).
    lowAnchor: "Perfect",
    highAnchor: "Failure",
  },
  {
    key: "effort",
    label: "Effort",
    description:
      "How hard did you have to work to accomplish your level of performance?",
    lowAnchor: "Very Low",
    highAnchor: "Very High",
  },
  {
    key: "frustration",
    label: "Frustration",
    description:
      "How insecure, discouraged, irritated, stressed, and annoyed were you?",
    lowAnchor: "Very Low",
    highAnchor: "Very High",
  },
] as const;

/** Inclusive bounds and step for every dimension's scale (Req 13.3). */
const MIN_SCORE = 0;
const MAX_SCORE = 100;
const STEP = 1;

/** Default position of an untouched slider; not treated as a rating. */
const DEFAULT_SLIDER_VALUE = 50;

export interface NasaTlxProps {
  /** The scenario this questionnaire follows, shown for researcher context. */
  scenario?: ScenarioId;
  /** Called with the six scores when a complete questionnaire is submitted. */
  onSubmit: (scores: NasaTlxScores) => void;
}

/** Per-dimension entry: the current value plus whether it has been rated. */
interface DimensionEntry {
  value: number;
  rated: boolean;
}

type EntryMap = Record<DimensionKey, DimensionEntry>;

/** Build the initial, fully-unrated entry map. */
function createInitialEntries(): EntryMap {
  const entries = {} as EntryMap;
  for (const key of DIMENSIONS) {
    entries[key] = { value: DEFAULT_SLIDER_VALUE, rated: false };
  }
  return entries;
}

/** Clamp a value into [0, 100] and round it to the nearest integer (Req 13.3). */
function normalizeScore(raw: number): number {
  if (!Number.isFinite(raw)) return MIN_SCORE;
  const clamped = Math.min(MAX_SCORE, Math.max(MIN_SCORE, raw));
  return Math.round(clamped);
}

export default function NasaTlx({ scenario, onSubmit }: NasaTlxProps) {
  const [entries, setEntries] = useState<EntryMap>(createInitialEntries);
  const [showMissing, setShowMissing] = useState(false);
  const headingId = useId();
  const alertId = useId();

  /** Dimensions still unrated, in presentation order (Req 13.6). */
  const missing = useMemo(
    () => DIMENSION_DEFS.filter((d) => !entries[d.key].rated),
    [entries],
  );

  /**
   * Record a rating for a dimension. Any interaction with a control marks the
   * dimension rated so an untouched slider stays distinct from a chosen 0.
   */
  function rate(key: DimensionKey, raw: number): void {
    const value = normalizeScore(raw);
    setEntries((prev) => ({ ...prev, [key]: { value, rated: true } }));
  }

  function handleSubmit(event: React.FormEvent<HTMLFormElement>): void {
    event.preventDefault();
    if (missing.length > 0) {
      // Block submission, surface which dimensions remain, keep ratings (Req 13.6).
      setShowMissing(true);
      return;
    }
    const scores: NasaTlxScores = {
      mental: entries.mental.value,
      physical: entries.physical.value,
      temporal: entries.temporal.value,
      performance: entries.performance.value,
      effort: entries.effort.value,
      frustration: entries.frustration.value,
    };
    onSubmit(scores);
  }

  return (
    <form
      aria-labelledby={headingId}
      onSubmit={handleSubmit}
      className="mx-auto flex w-full max-w-2xl flex-col gap-8 px-6 py-10 text-neutral-100"
    >
      <header className="flex flex-col gap-2">
        <h2 id={headingId} className="text-2xl font-semibold">
          Workload questionnaire
          {scenario ? (
            <span className="ml-2 text-base font-normal text-neutral-400">
              (Scenario {scenario})
            </span>
          ) : null}
        </h2>
        <p className="text-sm text-neutral-400">
          Rate each dimension from 0 to 100 based on how you experienced the
          task you just completed.
        </p>
      </header>

      {showMissing && missing.length > 0 ? (
        <div
          id={alertId}
          role="alert"
          className="rounded-md border border-amber-500/60 bg-amber-500/10 px-4 py-3 text-sm text-amber-200"
        >
          Please rate every dimension before submitting. Still unrated:{" "}
          {missing.map((d) => d.label).join(", ")}.
        </div>
      ) : null}

      <ol className="flex flex-col gap-8">
        {DIMENSION_DEFS.map((def) => {
          const entry = entries[def.key];
          const sliderId = `${headingId}-${def.key}-slider`;
          const numberId = `${headingId}-${def.key}-number`;
          const descId = `${headingId}-${def.key}-desc`;
          const isMissing = showMissing && !entry.rated;
          return (
            <li key={def.key} className="flex flex-col gap-3">
              <div className="flex flex-col gap-1">
                <label
                  htmlFor={sliderId}
                  className="text-base font-medium text-neutral-100"
                >
                  {def.label}
                </label>
                <p id={descId} className="text-sm text-neutral-400">
                  {def.description}
                </p>
              </div>

              <div className="flex items-center gap-4">
                <span
                  aria-hidden="true"
                  className="w-20 shrink-0 text-xs text-neutral-500"
                >
                  {def.lowAnchor}
                </span>
                <input
                  id={sliderId}
                  type="range"
                  min={MIN_SCORE}
                  max={MAX_SCORE}
                  step={STEP}
                  value={entry.value}
                  onChange={(e) => rate(def.key, e.currentTarget.valueAsNumber)}
                  aria-describedby={descId}
                  aria-valuetext={
                    entry.rated ? `${entry.value}` : "not yet rated"
                  }
                  className="h-2 w-full cursor-pointer appearance-none rounded-full bg-neutral-700 accent-neutral-100"
                />
                <span
                  aria-hidden="true"
                  className="w-20 shrink-0 text-right text-xs text-neutral-500"
                >
                  {def.highAnchor}
                </span>
              </div>

              <div className="flex items-center justify-between">
                <div className="flex items-center gap-2">
                  <label
                    htmlFor={numberId}
                    className="text-xs text-neutral-400"
                  >
                    Value
                  </label>
                  <input
                    id={numberId}
                    type="number"
                    inputMode="numeric"
                    min={MIN_SCORE}
                    max={MAX_SCORE}
                    step={STEP}
                    value={entry.rated ? entry.value : ""}
                    placeholder="—"
                    onChange={(e) => {
                      const raw = e.currentTarget.value;
                      if (raw === "") return;
                      rate(def.key, Number(raw));
                    }}
                    aria-describedby={descId}
                    className="w-20 rounded-md border border-neutral-700 bg-neutral-900 px-2 py-1 text-sm text-neutral-100 focus:border-neutral-400 focus:outline-none"
                  />
                </div>
                <span
                  className={
                    isMissing
                      ? "text-xs font-medium text-amber-300"
                      : "text-xs text-neutral-500"
                  }
                >
                  {entry.rated ? `Rated: ${entry.value}` : "Not yet rated"}
                </span>
              </div>
            </li>
          );
        })}
      </ol>

      <button
        type="submit"
        className="inline-flex w-fit items-center rounded-md bg-neutral-100 px-5 py-3 text-sm font-semibold text-neutral-900 transition hover:bg-white"
      >
        Submit ratings
      </button>
    </form>
  );
}
