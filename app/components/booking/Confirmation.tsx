"use client";

/**
 * Confirmation — final step of the shared booking flow (Req 10.3, 11.2).
 *
 * Reaching this screen is the Booking_Task completion signal: the task is now
 * done and `onComplete` fires exactly once so the harness can stop the scenario
 * timer (Req 11.2). The timing module itself is wired by the harness (task
 * 21.1); here the component is only responsible for calling `onComplete` on
 * mount and rendering the booking summary.
 */

import { useEffect, useRef } from "react";
import type { Flight } from "@/app/components/booking/FlightList";
import type { BookingFormValues } from "@/app/components/booking/BookingForm";

export interface ConfirmationProps {
  /** The booked flight. */
  flight: Flight;
  /** The submitted passenger/booking details. */
  booking: BookingFormValues;
  /**
   * Called once when the confirmation screen is reached — the completion signal
   * for the Booking_Task (Req 10.3, 11.2).
   */
  onComplete: () => void;
}

/** Format a rupiah amount for display, e.g. 980000 -> "Rp 980.000". */
function formatIdr(amount: number): string {
  return `Rp ${amount.toLocaleString("id-ID")}`;
}

export default function Confirmation({ flight, booking, onComplete }: ConfirmationProps) {
  // Fire the completion signal exactly once, even under React Strict Mode's
  // double-invocation of effects in development.
  const firedRef = useRef(false);
  useEffect(() => {
    if (firedRef.current) return;
    firedRef.current = true;
    onComplete();
  }, [onComplete]);

  return (
    <section
      aria-labelledby="confirmation-heading"
      data-testid="booking-confirmation"
      className="flex flex-col gap-4"
    >
      <div className="flex flex-col gap-1">
        <h2 id="confirmation-heading" className="text-xl font-semibold text-emerald-300">
          Booking confirmed
        </h2>
        <p className="text-sm text-neutral-400">
          Your flight is booked. A confirmation has been sent to {booking.email}.
        </p>
      </div>

      <dl className="grid grid-cols-[auto_1fr] gap-x-6 gap-y-2 rounded-lg border border-neutral-700 bg-neutral-900 px-4 py-4 text-sm">
        <dt className="text-neutral-400">Passenger</dt>
        <dd className="text-neutral-100">{booking.fullName}</dd>

        <dt className="text-neutral-400">Flight</dt>
        <dd className="text-neutral-100">
          {flight.airline} ({flight.id})
        </dd>

        <dt className="text-neutral-400">Route</dt>
        <dd className="text-neutral-100">
          {flight.from} {flight.departure} → {flight.to} {flight.arrival}
        </dd>

        <dt className="text-neutral-400">Passengers</dt>
        <dd className="text-neutral-100">{booking.passengers}</dd>

        <dt className="text-neutral-400">Total</dt>
        <dd className="text-neutral-100">{formatIdr(flight.priceIdr)}</dd>
      </dl>
    </section>
  );
}
