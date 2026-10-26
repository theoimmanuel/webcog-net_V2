/**
 * Task Completion Time measurement (Requirement 11).
 *
 * Produces the timing fields of a {@link StudyRecord} — `startTimestamp`,
 * `completionTimestamp`, `taskCompletionTimeMs`, and `status` — from scenario
 * start and confirmation events.
 *
 * The module is split into a pure core and a thin stateful wrapper so the logic
 * is easy to test and to wire into `SessionStore.setRecord`:
 *
 *  - {@link createSessionEpoch} anchors a session clock to `performance.now()`
 *    so every scenario timestamp is a millisecond-precision offset from one
 *    shared origin (Req 11.1, 11.2).
 *  - {@link computeTiming} is a pure function mapping (start, completion,
 *    abandoned) to the timing result (Req 11.3, 11.4, 11.5).
 *  - {@link ScenarioTimer} records the single start timestamp on first
 *    presentation and the single completion timestamp at confirmation, enforcing
 *    exactly one Task_Completion_Time per scenario per session (Req 11.6).
 *
 * All timestamps are millisecond-precision offsets from the session epoch; the
 * computed Task_Completion_Time is likewise in milliseconds.
 */
import type { RecordStatus, ScenarioId } from "@/lib/harness/session";

export type { RecordStatus, ScenarioId } from "@/lib/harness/session";

/**
 * The timing portion of a {@link StudyRecord}, as derived by this module. These
 * fields are spread onto a record before it is stored.
 */
export interface TimingResult {
  /** Scenario start timestamp (session-epoch ms), or null if never started. */
  startTimestamp: number | null;
  /** Confirmation timestamp (session-epoch ms), or null if not reached. */
  completionTimestamp: number | null;
  /** completionTimestamp - startTimestamp in ms, or null when not computable. */
  taskCompletionTimeMs: number | null;
  /** complete | incomplete | invalid, per Req 11.3-11.5. */
  status: RecordStatus;
}

/**
 * A monotonic session clock. `now()` returns the elapsed milliseconds since the
 * epoch was created, so all scenario timestamps share a single origin and are
 * directly comparable (Req 11.1, 11.2).
 */
export interface SessionEpoch {
  /** Milliseconds elapsed since this epoch was anchored. */
  now(): number;
}

/**
 * A function returning a high-resolution millisecond timestamp. Defaults to
 * `performance.now()` and is injectable so tests can supply a deterministic
 * clock.
 */
export type NowFn = () => number;

/**
 * Resolve a high-resolution clock. Uses `performance.now()` when available
 * (browser and modern Node), falling back to `Date.now()` so the module still
 * functions in environments without the Performance API.
 */
function defaultNow(): number {
  const perf = (globalThis as { performance?: { now?: () => number } }).performance;
  if (perf && typeof perf.now === "function") {
    return perf.now();
  }
  return Date.now();
}

/**
 * Anchor a session epoch to the current high-resolution time. Subsequent
 * `now()` calls return the millisecond offset from this anchor point, giving a
 * stable origin shared across every scenario in the session (Req 11.1).
 *
 * @param nowFn high-resolution clock; defaults to `performance.now()`.
 */
export function createSessionEpoch(nowFn: NowFn = defaultNow): SessionEpoch {
  const origin = nowFn();
  return {
    now(): number {
      return nowFn() - origin;
    },
  };
}

/**
 * Compute the timing result from recorded events — the pure core of Req 11.
 *
 * Status and Task_Completion_Time are decided as follows:
 *  - abandoned before confirmation → no time, status `incomplete` (Req 11.4).
 *  - completion recorded with no start → no time, status `invalid` (Req 11.5).
 *  - both start and completion present → `completionTimestamp - startTimestamp`,
 *    status `complete` (Req 11.3). The difference is non-negative whenever the
 *    completion is not earlier than the start (Property 28).
 *  - neither reached (started but not yet done, not abandoned) → no time,
 *    status `incomplete`.
 *
 * @param start      scenario start timestamp (session-epoch ms), or null.
 * @param completion confirmation timestamp (session-epoch ms), or null.
 * @param abandoned  whether the scenario was abandoned before confirmation.
 */
export function computeTiming(
  start: number | null,
  completion: number | null,
  abandoned = false,
): TimingResult {
  // Abandonment: no time is stored and the scenario is marked incomplete,
  // regardless of whether a start was recorded (Req 11.4).
  if (abandoned && completion === null) {
    return {
      startTimestamp: start,
      completionTimestamp: null,
      taskCompletionTimeMs: null,
      status: "incomplete",
    };
  }

  // Completion reached.
  if (completion !== null) {
    // Missing start → the measurement is invalid, no time stored (Req 11.5).
    if (start === null) {
      return {
        startTimestamp: null,
        completionTimestamp: completion,
        taskCompletionTimeMs: null,
        status: "invalid",
      };
    }
    // Both present → Task_Completion_Time is the difference (Req 11.3).
    return {
      startTimestamp: start,
      completionTimestamp: completion,
      taskCompletionTimeMs: completion - start,
      status: "complete",
    };
  }

  // Not yet completed and not abandoned: in progress, no time yet.
  return {
    startTimestamp: start,
    completionTimestamp: null,
    taskCompletionTimeMs: null,
    status: "incomplete",
  };
}

/**
 * Stateful timer for a single scenario. Records exactly one start timestamp on
 * first presentation and exactly one completion timestamp at confirmation;
 * later calls are ignored so that exactly one Task_Completion_Time is produced
 * per scenario per session (Req 11.6).
 *
 * Wire it to the harness by calling {@link start} when the scenario is first
 * presented, {@link complete} at the confirmation screen, or {@link abandon}
 * when the participant leaves early, then spread {@link result} onto the
 * `StudyRecord` passed to `SessionStore.setRecord`.
 */
export class ScenarioTimer {
  readonly scenario: ScenarioId;
  private readonly epoch: SessionEpoch;
  private startTimestamp: number | null = null;
  private completionTimestamp: number | null = null;
  private abandoned = false;

  /**
   * @param scenario the scenario this timer measures.
   * @param epoch    the shared session epoch; all timestamps are offsets from it.
   */
  constructor(scenario: ScenarioId, epoch: SessionEpoch) {
    this.scenario = scenario;
    this.epoch = epoch;
  }

  /**
   * Record the scenario start timestamp on first presentation (Req 11.1). Only
   * the first call takes effect; repeat presentations keep the original start.
   *
   * @returns true if the start was recorded; false if already started.
   */
  start(): boolean {
    if (this.startTimestamp !== null) return false;
    this.startTimestamp = this.epoch.now();
    return true;
  }

  /**
   * Record the completion timestamp when the confirmation screen is reached
   * (Req 11.2). Only the first completion counts, enforcing a single
   * Task_Completion_Time per scenario (Req 11.6). A completion after abandonment
   * is ignored.
   *
   * @returns true if the completion was recorded; false if already completed or
   *   abandoned.
   */
  complete(): boolean {
    if (this.completionTimestamp !== null || this.abandoned) return false;
    this.completionTimestamp = this.epoch.now();
    return true;
  }

  /**
   * Mark the scenario abandoned before confirmation (Req 11.4). Ignored once the
   * scenario has completed.
   *
   * @returns true if the abandonment was recorded; false if already completed.
   */
  abandon(): boolean {
    if (this.completionTimestamp !== null) return false;
    this.abandoned = true;
    return true;
  }

  /** Whether a start timestamp has been recorded. */
  hasStarted(): boolean {
    return this.startTimestamp !== null;
  }

  /** Whether a completion timestamp has been recorded. */
  hasCompleted(): boolean {
    return this.completionTimestamp !== null;
  }

  /**
   * Derive the current timing result (Req 11.3-11.6). Safe to call at any point;
   * returns the in-progress, complete, incomplete, or invalid result as
   * appropriate.
   */
  result(): TimingResult {
    return computeTiming(this.startTimestamp, this.completionTimestamp, this.abandoned);
  }
}
