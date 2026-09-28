import { describe, expect, it } from "vitest";
import { render, screen, within } from "@testing-library/react";
import HowItWorks from "./page";
import { PHASES } from "./pipeline";

describe("how-it-works page", () => {
  it("lists all seven steps, in order, before anything refers to them", () => {
    render(<HowItWorks />);
    const roster = document.querySelector(".pc-roster") as HTMLElement;
    const steps = [...roster.querySelectorAll(".pc-roster__cell--step")].map((el) => el.textContent);
    expect(steps).toEqual(PHASES.map((p) => p.step));
    for (const phase of PHASES) expect(within(roster).getByText(phase.title)).toBeInTheDocument();
  });

  // the roster exists so "step 05" means something — every number the
  // prose uses has to be one it defines
  it("only ever refers to steps the roster defines", () => {
    render(<HowItWorks />);
    const text = document.body.textContent ?? "";
    const referenced = [...text.matchAll(/\b(?:step|phase) (\d{2})\b/g)].map((m) => m[1]);
    expect(referenced.length).toBeGreaterThan(0);
    const defined = new Set(PHASES.map((p) => p.step));
    for (const n of referenced) expect(defined).toContain(n);
  });

  it("colors each step by the side it runs on", () => {
    render(<HowItWorks />);
    for (const phase of PHASES) {
      const cell = [...document.querySelectorAll(".pc-roster__cell--step")].find((el) => el.textContent === phase.step);
      expect(cell).toHaveClass(`pc-roster__step--${phase.side}`);
    }
  });

  it("draws the generated repo as a tree, marking the two files the prose calls out", () => {
    render(<HowItWorks />);
    const tree = document.querySelector(".pc-tree") as HTMLElement;
    expect(within(tree).getByText("homelab/")).toBeInTheDocument();
    const marked = [...tree.querySelectorAll(".pc-tree__name--marked")].map((el) => el.textContent);
    expect(marked).toEqual(["pve01.local.yml", ".wizard/state.json"]);
  });

  it("renders the pipeline diagram with a card per phase", () => {
    render(<HowItWorks />);
    expect(document.querySelectorAll(".pc-phase")).toHaveLength(PHASES.length);
    expect(document.querySelectorAll(".pc-lane")).toHaveLength(2);
  });

  it("explains the site.yml bands in order", () => {
    render(<HowItWorks />);
    const tags = [...document.querySelectorAll(".pc-table--wrap tbody td:first-child")].map((el) => el.textContent);
    expect(tags).toEqual(["preflight", "base", "network", "cluster", "storage", "backups", "workloads"]);
  });

  it("links back into the wizard", () => {
    render(<HowItWorks />);
    const links = screen.getAllByRole("link", { name: /setup|start at step 01/i });
    expect(links.length).toBeGreaterThan(0);
    for (const link of links) expect(link).toHaveAttribute("href", "/setup");
  });
});
