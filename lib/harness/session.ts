/**
 * Shared study-data types and the client-side session store.
 *
 * The store is the single source of truth for a Study_Session while the
 * participant works through the experiment. It keeps all state in memory and
 * mirrors it into `sessionStorage` so an accidental reload within the same tab
 * does not lose collected data (per design: "sessionStorage survives accidental
 * reloads within a session; export reads from in-memory store").
 *
 * Two invariants are enforced by this module:
 *  - Exactly one record is stored per scenario per Study_Session (Req 11.6).
 *  - No study data is collected until consent has been granted (Req 2.3);
 *    writes attempted before consent are rejected and leave state unchanged.
 */

export type ScenarioId = "A" | "B" | "C";

export type ScenarioOrder = [ScenarioId, ScenarioId, ScenarioId];

export type RecordStatus = "complete" | "incomplete" | "invalid";

/** The six NASA-TLX dimension scores, each an integer in [0, 100] (Req 13.3). */
export interface NasaTlxScores {
  mental: number;
  physical: number;
  temporal: number;
  performance: number;
  effort: number;
  frustration: number;
}

/** Inference-latency statistics across a scenario's inferences (Req 4.4, 4.5). */
export interface LatencyStats {
  meanMs: number;
  maxMs: number;
  p95Ms: number;
  /** True when any measured latency is >= 5 ms (Req 4.5). */
  exceedsTarget: boolean;
  sampleCount: number;
}

/** The collected measures for a single scenario (Req 11, 13, 14). */
export interface StudyRecord {
  scenario: ScenarioId;
  status: RecordStatus;
  /** Scenario start timestamp, ms precision, session epoch (Req 11.1). */
  startTimestamp: number | null;
  /** Confirmation-screen timestamp, ms precision (Req 11.2). */
  completionTimestamp: number | null;
  /** completionTimestamp - startTimestamp (Req 11.3, 11.6). */
  taskCompletionTimeMs: number | null;
  tlx: NasaTlxScores | null;
  latency: LatencyStats | null;
  /** Whether an adaptive declutter intervention was applied (Scenario C only). */
  interventionApplied: boolean;
}

/** The full session-level state collected during one study run (Req 11, 14). */
export interface StudySession {
  participantId: string;
  sessionId: string;
  /** ISO 8601 UTC consent timestamp, or null before consent (Req 2.4, 14.5). */
  consentTimestamp: string | null;
  consentGranted: boolean;
  scenarioOrder: ScenarioOrder | null;
  records: Record<ScenarioId, StudyRecord>;
  /** Measured total model artifact size in bytes (Req 4.3). */
  modelSizeBytes: number;
  /** True when the model artifact is >= 51,200 bytes (Req 4.6). */
  modelSizeExceeds: boolean;
}

/** Byte threshold (50 KB) at and above which the model size flag is set (Req 4.6). */
export const MODEL_SIZE_LIMIT_BYTES = 51_200;

const STORAGE_KEY = "webcog-net:study-session";

export interface SessionStoreOptions {
  participantId: string;
  sessionId: string;
}

/**
 * Build a fresh, consent-pending session with no records.
 */
function createEmptySession(participantId: string, sessionId: string): StudySession {
  return {
    participantId,
    sessionId,
    consentTimestamp: null,
    consentGranted: false,
    scenarioOrder: null,
    records: {} as Record<ScenarioId, StudyRecord>,
    modelSizeBytes: 0,
    modelSizeExceeds: false,
  };
}

/**
 * Access `sessionStorage` safely. Returns null when it is unavailable, such as
 * during server-side rendering or in a test environment without the API. All
 * callers must tolerate a null result and keep operating from memory.
 */
function getSessionStorage(): Storage | null {
  try {
    if (typeof globalThis === "undefined") return null;
    const storage = (globalThis as { sessionStorage?: Storage }).sessionStorage;
    if (!storage) return null;
    // Touch the API to surface access errors (e.g. disabled storage) early.
    const probe = "__webcog_probe__";
    storage.setItem(probe, "1");
    storage.removeItem(probe);
    return storage;
  } catch {
    return null;
  }
}

/**
 * Validate that a parsed value looks like a `StudySession`. Used when rehydrating
 * from `sessionStorage` so corrupt or foreign data does not poison the store.
 */
function isStudySession(value: unknown): value is StudySession {
  if (typeof value !== "object" || value === null) return false;
  const v = value as Record<string, unknown>;
  return (
    typeof v.participantId === "string" &&
    typeof v.sessionId === "string" &&
    (v.consentTimestamp === null || typeof v.consentTimestamp === "string") &&
    typeof v.consentGranted === "boolean" &&
    typeof v.records === "object" &&
    v.records !== null &&
    typeof v.modelSizeBytes === "number" &&
    typeof v.modelSizeExceeds === "boolean"
  );
}

/**
 * The study session store: in-memory source of truth with a `sessionStorage`
 * mirror. Construct one per study run. Writes of study data are rejected until
 * consent is granted, and each scenario accepts exactly one record.
 */
export class SessionStore {
  private session: StudySession;

  constructor(options: SessionStoreOptions) {
    const rehydrated = SessionStore.rehydrate(options);
    this.session = rehydrated ?? createEmptySession(options.participantId, options.sessionId);
    this.persist();
  }

  /**
   * Attempt to restore a matching session from `sessionStorage`. Returns null if
   * storage is unavailable, empty, corrupt, or belongs to a different session.
   */
  private static rehydrate(options: SessionStoreOptions): StudySession | null {
    const storage = getSessionStorage();
    if (!storage) return null;
    try {
      const raw = storage.getItem(STORAGE_KEY);
      if (!raw) return null;
      const parsed: unknown = JSON.parse(raw);
      if (!isStudySession(parsed)) return null;
      if (
        parsed.participantId !== options.participantId ||
        parsed.sessionId !== options.sessionId
      ) {
        return null;
      }
      return parsed;
    } catch {
      return null;
    }
  }

  /** Write the current in-memory session to the `sessionStorage` mirror. */
  private persist(): void {
    const storage = getSessionStorage();
    if (!storage) return;
    try {
      storage.setItem(STORAGE_KEY, JSON.stringify(this.session));
    } catch {
      // Storage may be full or disabled mid-session; memory remains authoritative.
    }
  }

  /** Return a deep copy of the current session so callers cannot mutate state. */
  getSession(): StudySession {
    return structuredCloneSession(this.session);
  }

  /** Whether consent has been granted and study-data writes are permitted. */
  isConsentGranted(): boolean {
    return this.session.consentGranted;
  }

  /**
   * Grant consent and record the ISO 8601 UTC timestamp (Req 2.4). Consent can
   * only be granted once; a repeat call keeps the original timestamp.
   */
  grantConsent(timestamp: string = new Date().toISOString()): void {
    if (this.session.consentGranted) return;
    this.session.consentGranted = true;
    this.session.consentTimestamp = timestamp;
    this.persist();
  }

  /**
   * Record the assigned scenario order (Req 12.3). Rejected before consent and
   * never overwritten once set.
   *
   * @returns true if the order was stored; false if the write was rejected.
   */
  setScenarioOrder(order: ScenarioOrder): boolean {
    if (!this.session.consentGranted) return false;
    if (this.session.scenarioOrder !== null) return false;
    this.session.scenarioOrder = [...order] as ScenarioOrder;
    this.persist();
    return true;
  }

  /**
   * Record the measured model artifact size and derive the size-exceeds flag
   * (Req 4.3, 4.6). Rejected before consent.
   *
   * @returns true if stored; false if the write was rejected.
   */
  setModelSize(bytes: number): boolean {
    if (!this.session.consentGranted) return false;
    this.session.modelSizeBytes = bytes;
    this.session.modelSizeExceeds = bytes >= MODEL_SIZE_LIMIT_BYTES;
    this.persist();
    return true;
  }

  /** Whether a record already exists for the given scenario. */
  hasRecord(scenario: ScenarioId): boolean {
    return Object.prototype.hasOwnProperty.call(this.session.records, scenario);
  }

  /** Return a copy of the stored record for a scenario, or null if none. */
  getRecord(scenario: ScenarioId): StudyRecord | null {
    const record = this.session.records[scenario];
    return record ? { ...record } : null;
  }

  /**
   * Store the single record for a scenario (Req 11.6). The write is rejected if
   * consent has not been granted (Req 2.3) or if a record already exists for the
   * scenario — enforcing exactly one record per scenario per session.
   *
   * @returns true if the record was stored; false if the write was rejected.
   */
  setRecord(scenario: ScenarioId, record: StudyRecord): boolean {
    if (!this.session.consentGranted) return false;
    if (this.hasRecord(scenario)) return false;
    this.session.records[scenario] = { ...record, scenario };
    this.persist();
    return true;
  }

  /** Clear the `sessionStorage` mirror. Memory state is left untouched. */
  clearStorage(): void {
    const storage = getSessionStorage();
    if (!storage) return;
    try {
      storage.removeItem(STORAGE_KEY);
    } catch {
      // Ignore: storage mirror is best-effort.
    }
  }
}

/** Produce an independent copy of a session, including its records map. */
function structuredCloneSession(session: StudySession): StudySession {
  const records = {} as Record<ScenarioId, StudyRecord>;
  for (const key of Object.keys(session.records) as ScenarioId[]) {
    const r = session.records[key];
    records[key] = {
      ...r,
      tlx: r.tlx ? { ...r.tlx } : null,
      latency: r.latency ? { ...r.latency } : null,
    };
  }
  return {
    ...session,
    scenarioOrder: session.scenarioOrder ? ([...session.scenarioOrder] as ScenarioOrder) : null,
    records,
  };
}
