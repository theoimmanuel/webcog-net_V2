"use client";

/**
 * BookingForm — step two of the shared booking flow (Req 10.2, 10.4).
 *
 * Presents the passenger/booking form for a selected flight. All fields are
 * required; the form validates on submit using client-side logic (rather than
 * native-only validation) so it can show a message for EACH affected field plus
 * a summary, retain every entered value on failure, and leave the task not done
 * (Req 10.4, Property 26). Only when every field is valid does it call
 * `onSubmit` to advance to the confirmation screen (Req 10.3, Property 25).
 */

import { useState } from "react";
import type { Flight } from "@/app/components/booking/FlightList";

/** The collected passenger/booking values. All are required (Req 10.2). */
export interface BookingFormValues {
  fullName: string;
  email: string;
  passengers: string;
  cardNumber: string;
  cardExpiry: string;
  cardCvc: string;
}

export interface BookingFormProps {
  /** The flight chosen on the previous step, shown as a summary. */
  flight: Flight;
  /** Called with the validated values when every required field is valid. */
  onSubmit: (values: BookingFormValues) => void;
}

/** Per-field error messages, keyed by field. Absent key means that field is valid. */
type FieldErrors = Partial<Record<keyof BookingFormValues, string>>;

const EMPTY_VALUES: BookingFormValues = {
  fullName: "",
  email: "",
  passengers: "1",
  cardNumber: "",
  cardExpiry: "",
  cardCvc: "",
};

/** Field metadata driving rendering and keeping label/input/error wired together. */
interface FieldDef {
  name: keyof BookingFormValues;
  label: string;
  type: "text" | "email" | "number" | "tel";
  autoComplete?: string;
  inputMode?: "numeric" | "email" | "text";
  placeholder?: string;
}

const FIELDS: readonly FieldDef[] = [
  { name: "fullName", label: "Full name", type: "text", autoComplete: "name" },
  { name: "email", label: "Email", type: "email", autoComplete: "email", inputMode: "email" },
  {
    name: "passengers",
    label: "Passengers",
    type: "number",
    inputMode: "numeric",
  },
  {
    name: "cardNumber",
    label: "Card number",
    type: "tel",
    autoComplete: "cc-number",
    inputMode: "numeric",
    placeholder: "1234 5678 9012 3456",
  },
  {
    name: "cardExpiry",
    label: "Expiry (MM/YY)",
    type: "text",
    autoComplete: "cc-exp",
    placeholder: "MM/YY",
  },
  {
    name: "cardCvc",
    label: "CVC",
    type: "tel",
    autoComplete: "cc-csc",
    inputMode: "numeric",
    placeholder: "123",
  },
];

const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
const CARD_RE = /^\d{13,19}$/;
const EXPIRY_RE = /^(0[1-9]|1[0-2])\/\d{2}$/;
const CVC_RE = /^\d{3,4}$/;

/**
 * Validate all fields, returning a message for each invalid field. An empty
 * returned object means the whole form is valid. Validation never mutates the
 * supplied values, so callers can safely retain them on failure (Req 10.4).
 */
export function validateBookingForm(values: BookingFormValues): FieldErrors {
  const errors: FieldErrors = {};

  if (values.fullName.trim() === "") {
    errors.fullName = "Enter the passenger's full name.";
  }

  if (values.email.trim() === "") {
    errors.email = "Enter an email address.";
  } else if (!EMAIL_RE.test(values.email.trim())) {
    errors.email = "Enter a valid email address.";
  }

  const passengers = Number(values.passengers);
  if (values.passengers.trim() === "") {
    errors.passengers = "Enter the number of passengers.";
  } else if (!Number.isInteger(passengers) || passengers < 1) {
    errors.passengers = "Passengers must be a whole number of 1 or more.";
  }

  const card = values.cardNumber.replace(/\s+/g, "");
  if (values.cardNumber.trim() === "") {
    errors.cardNumber = "Enter the card number.";
  } else if (!CARD_RE.test(card)) {
    errors.cardNumber = "Enter a valid card number (digits only).";
  }

  if (values.cardExpiry.trim() === "") {
    errors.cardExpiry = "Enter the card expiry.";
  } else if (!EXPIRY_RE.test(values.cardExpiry.trim())) {
    errors.cardExpiry = "Use MM/YY format.";
  }

  if (values.cardCvc.trim() === "") {
    errors.cardCvc = "Enter the card CVC.";
  } else if (!CVC_RE.test(values.cardCvc.trim())) {
    errors.cardCvc = "CVC must be 3 or 4 digits.";
  }

  return errors;
}

export default function BookingForm({ flight, onSubmit }: BookingFormProps) {
  const [values, setValues] = useState<BookingFormValues>(EMPTY_VALUES);
  const [errors, setErrors] = useState<FieldErrors>({});
  const [submitted, setSubmitted] = useState(false);

  function handleChange(name: keyof BookingFormValues, value: string): void {
    // Retain entered values and re-validate the touched field after a failed
    // submit so error messages clear as the participant corrects them.
    setValues((prev) => {
      const next = { ...prev, [name]: value };
      if (submitted) {
        setErrors(validateBookingForm(next));
      }
      return next;
    });
  }

  function handleSubmit(event: React.FormEvent<HTMLFormElement>): void {
    event.preventDefault();
    setSubmitted(true);
    const nextErrors = validateBookingForm(values);
    setErrors(nextErrors);
    // Any invalid field blocks submission; values are retained because state is
    // never reset here and the task remains not done (Req 10.4).
    if (Object.keys(nextErrors).length > 0) {
      return;
    }
    onSubmit(values);
  }

  const errorEntries = Object.entries(errors) as [keyof BookingFormValues, string][];
  const hasErrors = errorEntries.length > 0;
  const labelFor = (name: keyof BookingFormValues): string =>
    FIELDS.find((f) => f.name === name)?.label ?? name;

  return (
    <section aria-labelledby="booking-form-heading" className="flex flex-col gap-4">
      <div className="flex flex-col gap-1">
        <h2 id="booking-form-heading" className="text-xl font-semibold">
          Passenger &amp; payment details
        </h2>
        <p className="text-sm text-neutral-400">
          {flight.airline} ({flight.id}) · {flight.from} {flight.departure} →{" "}
          {flight.to} {flight.arrival}
        </p>
      </div>

      {hasErrors && (
        <div
          role="alert"
          data-testid="form-error-summary"
          className="rounded-md border border-red-500/60 bg-red-500/10 px-4 py-3 text-sm text-red-200"
        >
          <p className="font-medium">Please fix the following:</p>
          <ul className="mt-1 list-inside list-disc">
            {errorEntries.map(([name, message]) => (
              <li key={name}>
                {labelFor(name)}: {message}
              </li>
            ))}
          </ul>
        </div>
      )}

      <form noValidate onSubmit={handleSubmit} className="flex flex-col gap-4">
        {FIELDS.map((field) => {
          const error = errors[field.name];
          const errorId = `${field.name}-error`;
          return (
            <div key={field.name} className="flex flex-col gap-1">
              <label htmlFor={field.name} className="text-sm font-medium text-neutral-200">
                {field.label}
              </label>
              <input
                id={field.name}
                name={field.name}
                type={field.type}
                inputMode={field.inputMode}
                autoComplete={field.autoComplete}
                placeholder={field.placeholder}
                value={values[field.name]}
                min={field.name === "passengers" ? 1 : undefined}
                onChange={(e) => handleChange(field.name, e.target.value)}
                aria-required="true"
                aria-invalid={error ? "true" : undefined}
                aria-describedby={error ? errorId : undefined}
                className={`rounded-md border bg-neutral-900 px-3 py-2 text-sm text-neutral-100 focus:outline-none focus-visible:ring-2 focus-visible:ring-neutral-300 ${
                  error ? "border-red-500" : "border-neutral-700"
                }`}
              />
              {error && (
                <p id={errorId} role="alert" className="text-sm text-red-300">
                  {error}
                </p>
              )}
            </div>
          );
        })}

        <button
          type="submit"
          className="mt-2 inline-flex w-fit items-center rounded-md bg-neutral-100 px-5 py-2.5 text-sm font-semibold text-neutral-900 transition hover:bg-white focus:outline-none focus-visible:ring-2 focus-visible:ring-neutral-300"
        >
          Confirm booking
        </button>
      </form>
    </section>
  );
}
