import { describe, expect, it } from "vitest";
import { render, screen } from "@testing-library/react";
import Home from "./page";
import wizardSteps from "@/data/wizard-steps.json";

describe("landing page", () => {
  it("sends visitors into the wizard", () => {
    render(<Home />);
    const starts = screen.getAllByRole("link", { name: /start the setup/i });
    expect(starts.length).toBeGreaterThan(0);
    for (const link of starts) expect(link).toHaveAttribute("href", "/setup");
  });

  it("links to the explainer and to the repository", () => {
    render(<Home />);
    for (const link of screen.getAllByRole("link", { name: /how it works/i })) {
      expect(link).toHaveAttribute("href", "/how-it-works");
    }
    expect(screen.getByRole("link", { name: /github/i })).toHaveAttribute(
      "href",
      "https://github.com/thomasreiser/proxmox.computer",
    );
  });

  it("shows every wizard step", () => {
    render(<Home />);
    for (const step of wizardSteps) expect(screen.getAllByText(step.label).length).toBeGreaterThan(0);
  });
});
