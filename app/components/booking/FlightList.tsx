"use client";

/**
 * FlightList — step one of the shared booking flow (Req 10.1).
 *
 * Presents a static list of at least two selectable flight options for the
 * Booking_Task ("find the cheapest morning flight from Jakarta (CGK) to Bali
 * (DPS) and complete a booking"). Each option shows its departure time, arrival
 * time, and price so the participant can compare and choose (Property 23).
 *
 * The component is presentational: it owns no step state. Selecting a flight
 * calls `onSelect` with the chosen flight; the parent BookingTask advances the
 * step machine to the form.
 */

/** A single bookable flight option shown in the list (Req 10.1). */
export interface Flight {
  id: string;
  /** Operating carrier, shown for context. */
  airline: string;
  /** Origin airport code, e.g. "CGK". */
  from: string;
  /** Destination airport code, e.g. "DPS". */
  to: string;
  /** Local departure time, 24-hour "HH:MM". */
  departure: string;
  /** Local arrival time, 24-hour "HH:MM". */
  arrival: string;
  /** Fare in Indonesian rupiah (whole currency units). */
  priceIdr: number;
}

export interface FlightListProps {
  /** Called with the chosen flight when a participant selects an option. */
  onSelect: (flight: Flight) => void;
}

/**
 * Static morning CGK → DPS options. At least two are provided so the list is
 * always comparable (Req 10.1); the cheapest is intentionally not the first so
 * the task requires reading the prices.
 */
export const FLIGHTS: readonly Flight[] = [
  {
    id: "GA-402",
    airline: "Garuda Indonesia",
    from: "CGK",
    to: "DPS",
    departure: "06:20",
    arrival: "09:05",
    priceIdr: 1_250_000,
  },
  {
    id: "QG-684",
    airline: "Citilink",
    from: "CGK",
    to: "DPS",
    departure: "07:45",
    arrival: "10:30",
    priceIdr: 980_000,
  },
  {
    id: "ID-6512",
    airline: "Batik Air",
    from: "CGK",
    to: "DPS",
    departure: "08:30",
    arrival: "11:20",
    priceIdr: 1_110_000,
  },
];

/** Format a rupiah amount for display, e.g. 980000 -> "Rp 980.000". */
function formatIdr(amount: number): string {
  return `Rp ${amount.toLocaleString("id-ID")}`;
}

export default function FlightList({ onSelect }: FlightListProps) {
  return (
    <section aria-labelledby="flight-list-heading" className="flex flex-col gap-4">
      <div className="flex flex-col gap-1">
        <h2 id="flight-list-heading" className="text-xl font-semibold">
          Choose a flight
        </h2>
        <p className="text-sm text-neutral-400">
          Jakarta (CGK) → Bali (DPS). Select the cheapest morning departure.
        </p>
      </div>

      <ul className="flex flex-col gap-3">
        {FLIGHTS.map((flight) => (
          <li key={flight.id}>
            <button
              type="button"
              onClick={() => onSelect(flight)}
              className="flex w-full items-center justify-between gap-4 rounded-lg border border-neutral-700 bg-neutral-900 px-4 py-3 text-left transition hover:border-neutral-400 focus:outline-none focus-visible:ring-2 focus-visible:ring-neutral-300"
            >
              <span className="flex flex-col gap-1">
                <span className="text-sm font-medium text-neutral-100">
                  {flight.airline}{" "}
                  <span className="text-neutral-500">({flight.id})</span>
                </span>
                <span className="text-sm text-neutral-300">
                  <span data-testid={`departure-${flight.id}`}>
                    {flight.from} {flight.departure}
                  </span>
                  {" → "}
                  <span data-testid={`arrival-${flight.id}`}>
                    {flight.to} {flight.arrival}
                  </span>
                </span>
              </span>
              <span
                data-testid={`price-${flight.id}`}
                className="shrink-0 text-base font-semibold text-neutral-100"
              >
                {formatIdr(flight.priceIdr)}
              </span>
            </button>
          </li>
        ))}
      </ul>
    </section>
  );
}
