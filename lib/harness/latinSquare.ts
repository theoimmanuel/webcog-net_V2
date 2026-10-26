/**
 * Latin-Square counterbalancing for scenario ordering (Requirement 12).
 *
 * Provides the six distinct orderings of the three scenarios {A, B, C}, a
 * balanced least-used assignment strategy, and an exactly-once validity check.
 *
 * - `allOrders()`      — the 6 permutations of {A, B, C} (Req 12.1, 12.4)
 * - `assignOrder()`    — picks the least-used ordering, balanced within ±1 (Req 12.1)
 * - `isValidOrder()`   — exactly-once check; invalid orders are rejected so the
 *                        caller can leave the session unstarted (Req 12.4, 12.5)
 */
import type { ScenarioId, ScenarioOrder } from "@/lib/harness/session";

export type { ScenarioId, ScenarioOrder } from "@/lib/harness/session";

/** The three scenario identifiers that make up every ordering. */
const SCENARIOS: readonly ScenarioId[] = ["A", "B", "C"] as const;

/**
 * The six distinct permutations of {A, B, C}, in a stable canonical sequence.
 * A fresh array is returned on every call so callers cannot mutate the source.
 */
export function allOrders(): ScenarioOrder[] {
  return [
    ["A", "B", "C"],
    ["A", "C", "B"],
    ["B", "A", "C"],
    ["B", "C", "A"],
    ["C", "A", "B"],
    ["C", "B", "A"],
  ];
}

/**
 * Serialize an ordering to a stable key (e.g. "ABC") for tallying prior counts.
 */
export function orderKey(order: ScenarioOrder): string {
  return order.join("");
}

/**
 * Assign the next scenario order from the six permutations, keeping the
 * distribution balanced: the least-used ordering is chosen, so across many
 * assignments the counts of any two orderings differ by at most one (Req 12.1).
 *
 * Ties are broken by the canonical order from `allOrders()`, which keeps the
 * assignment deterministic and reproducible for a given tally.
 *
 * @param priorCounts tally of how many times each ordering (keyed by `orderKey`,
 *   e.g. "ABC") has already been assigned. Missing keys count as zero.
 */
export function assignOrder(
  priorCounts: Record<string, number>,
): ScenarioOrder {
  const orders = allOrders();

  let best: ScenarioOrder = orders[0];
  let bestCount = countFor(priorCounts, best);

  for (let i = 1; i < orders.length; i++) {
    const candidate = orders[i];
    const count = countFor(priorCounts, candidate);
    if (count < bestCount) {
      best = candidate;
      bestCount = count;
    }
  }

  return best;
}

/**
 * Read the prior count for an ordering, treating missing or non-finite,
 * non-positive values as zero so a malformed tally never skews assignment.
 */
function countFor(
  priorCounts: Record<string, number>,
  order: ScenarioOrder,
): number {
  const raw = priorCounts[orderKey(order)];
  return typeof raw === "number" && Number.isFinite(raw) && raw > 0 ? raw : 0;
}

/**
 * Type guard: an order is valid iff it is one of the six permutations of
 * {A, B, C} — length 3 with each of A, B, and C present exactly once
 * (Req 12.4). Invalid orders return false so callers reject them and leave the
 * session unstarted (Req 12.5).
 */
export function isValidOrder(o: ScenarioId[]): o is ScenarioOrder {
  if (!Array.isArray(o) || o.length !== SCENARIOS.length) {
    return false;
  }
  return SCENARIOS.every(
    (scenario) => o.filter((id) => id === scenario).length === 1,
  );
}
