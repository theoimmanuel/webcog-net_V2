import { describe, it, expect } from "vitest";
import { render, screen } from "@testing-library/react";
import fc from "fast-check";
import Home from "./page";

describe("baseline toolchain", () => {
  it("renders the landing page heading (RTL + jsdom + jest-dom)", () => {
    render(<Home />);
    expect(
      screen.getByRole("heading", { name: /webcog-net/i, level: 1 }),
    ).toBeInTheDocument();
  });

  it("links into the study flow", () => {
    render(<Home />);
    const link = screen.getByRole("link", { name: /enter the study/i });
    expect(link).toHaveAttribute("href", "/study");
  });

  it("runs a fast-check property (toolchain smoke)", () => {
    fc.assert(
      fc.property(fc.integer(), fc.integer(), (a, b) => {
        return a + b === b + a;
      }),
    );
  });
});
