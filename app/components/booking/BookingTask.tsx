"use client";

/**
 * BookingTask — the shared booking flow used by every scenario (Req 10).
 *
 * A single component guarantees an identical step sequence across Scenarios A,
 * B, and C (Req 10.5): FlightList → BookingForm → Confirmation. Only the
 * surrounding chrome differs per scenario, and that chrome is injected by the
 * scenario view (a separate task), so this component stays visually neutral.
 *
 * The step is tracked by an explicit state machine (`BookingStep`) so the
 * sequence is deterministic and testable (Property 27, task 15.2). Reaching the
 * confirmation step is the completion signal that calls `onComplete` so the
 * harness can stop the scenario timer (Req 11.2); the timer wiring lives in the
 * harness (task 21.1).
 */

import { useState } from "react";
import type { ScenarioId } from "@/lib/harness/session";
import FlightList, { type Flight } from "@/app/components/booking/FlightList";
import BookingForm, { type BookingFormValues } from "@/app/components/booking/BookingForm";
import Confirmation from "@/app/components/booking/Confirmation";

/** The explicit steps of the booking flow, always traversed in this order. */
export type BookingStep = "list" | "form" | "confirmation";

export interface BookingTaskProps {
  /** Which scenario this booking task belongs to (chrome is applied elsewhere). */
  scenario: ScenarioId;
  /**
   * Called when the confirmation screen is reached — the Booking_Task
   * completion signal used to stop the scenario timer (Req 11.2).
   */
  onComplete: () => void;
  /** Optional: called if the participant leaves the task before confirmation. */
  onAbandon?: () => void;
}

export default function BookingTask({ scenario, onComplete }: BookingTaskProps) {
  const [step, setStep] = useState<BookingStep>("list");
  const [flight, setFlight] = useState<Flight | null>(null);
  const [booking, setBooking] = useState<BookingFormValues | null>(null);

  function handleFlightSelect(selected: Flight): void {
    setFlight(selected);
    setStep("form");
  }

  function handleFormSubmit(values: BookingFormValues): void {
    setBooking(values);
    setStep("confirmation");
  }

  return (
    <div data-scenario={scenario} data-booking-step={step} className="flex flex-col gap-6">
      {step === "list" && <FlightList onSelect={handleFlightSelect} />}

      {step === "form" && flight && (
        <BookingForm flight={flight} onSubmit={handleFormSubmit} />
      )}

      {step === "confirmation" && flight && booking && (
        <Confirmation flight={flight} booking={booking} onComplete={onComplete} />
      )}
    </div>
  );
}

export { FlightList, BookingForm, Confirmation };
export type { Flight, BookingFormValues };
