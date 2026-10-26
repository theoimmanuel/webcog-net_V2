// Feature: webcog-net-site
//
// Photosensitive-safety flash cap (Req 7.3, 7.4, 8.7, Property 17).
//
// Scenario B is deliberately overwhelming, and Scenario C starts out identical,
// but neither may ever flash a visual element faster than the photosensitive
// safety limit: at most 3 flashes within ANY rolling 1-second interval. A
// "flash" here is a single opacity/visibility toggle of an element (on or off
// counts as one toggle).
//
// `SafeFlash` is a pure, framework-free guard. Given a request to toggle at
// time `t`, it admits the toggle only when fewer than `MAX_FLASHES_PER_SECOND`
// toggles have been admitted in the trailing `FLASH_WINDOW_MS`; otherwise it
// suppresses it (Req 7.4). It records only admitted toggles, so a suppressed
// request does not count against the budget — the element simply holds its
// current visual state until the window drains.
//
// The clock is injectable so the guard is deterministic and unit/property
// testable without real time (Property 17). In the chrome, any element that
// toggles visibility routes its toggle through a `SafeFlash` instance; the
// chrome otherwise prefers non-flashing transform animations (translate/scale/
// scroll) that need no cap at all.

/** Maximum opacity/visibility toggles permitted in any rolling 1 s window. */
export const MAX_FLASHES_PER_SECOND = 3;

/** The rolling window, in milliseconds, over which flashes are counted. */
export const FLASH_WINDOW_MS = 1000;

/** A monotonic clock returning epoch milliseconds. Injectable for tests. */
export type Clock = () => number;

/** Options for {@link SafeFlash}. */
export interface SafeFlashOptions {
  /**
   * Max toggles admitted per {@link FLASH_WINDOW_MS}. Defaults to
   * {@link MAX_FLASHES_PER_SECOND} (3). Overridable for tests.
   */
  maxPerWindow?: number;
  /**
   * Rolling window length in ms. Defaults to {@link FLASH_WINDOW_MS} (1000).
   * Overridable for tests.
   */
  windowMs?: number;
  /**
   * Clock used to timestamp toggles. Defaults to a `performance.now()`-based
   * clock when available, falling back to `Date.now()`. Inject a fake clock in
   * tests for deterministic behavior (Property 17).
   */
  clock?: Clock;
}

/** Default clock: prefer `performance.now()`, fall back to `Date.now()`. */
function defaultClock(): number {
  if (typeof performance !== "undefined" && typeof performance.now === "function") {
    return performance.now();
  }
  return Date.now();
}

/**
 * A rolling-window flash cap. One instance guards one logical flashing element
 * (or group that shares a budget). Call {@link request} each time the element
 * wants to toggle visibility; act on the toggle only when it returns `true`.
 */
export class SafeFlash {
  private readonly maxPerWindow: number;
  private readonly windowMs: number;
  private readonly clock: Clock;

  /** Timestamps (ms) of admitted toggles within the current rolling window. */
  private readonly admitted: number[] = [];

  constructor(options: SafeFlashOptions = {}) {
    this.maxPerWindow = options.maxPerWindow ?? MAX_FLASHES_PER_SECOND;
    this.windowMs = options.windowMs ?? FLASH_WINDOW_MS;
    this.clock = options.clock ?? defaultClock;
  }

  /**
   * Request a toggle. Returns `true` if admitting it keeps the element at or
   * below the cap for the trailing window, `false` to suppress it (Req 7.4).
   *
   * `now` may be passed explicitly (useful for tests and for pairing the
   * decision with the exact event time); otherwise the injected clock is read.
   * Suppressed requests are not recorded, so they never consume budget.
   */
  request(now: number = this.clock()): boolean {
    this.evict(now);
    if (this.admitted.length >= this.maxPerWindow) {
      return false;
    }
    this.admitted.push(now);
    return true;
  }

  /**
   * How many toggles have been admitted in the trailing window as of `now`.
   * Primarily a test/inspection aid.
   */
  countInWindow(now: number = this.clock()): number {
    this.evict(now);
    return this.admitted.length;
  }

  /** Clear all recorded toggles, resetting the budget. */
  reset(): void {
    this.admitted.length = 0;
  }

  /** Drop admitted timestamps that have fallen out of the trailing window. */
  private evict(now: number): void {
    const cutoff = now - this.windowMs;
    // Timestamps are pushed in non-decreasing order, so expired entries are a
    // prefix; shift them off until the oldest is still within the window.
    while (this.admitted.length > 0 && this.admitted[0] <= cutoff) {
      this.admitted.shift();
    }
  }
}

/** Create a {@link SafeFlash} guard. */
export function createSafeFlash(options?: SafeFlashOptions): SafeFlash {
  return new SafeFlash(options);
}
