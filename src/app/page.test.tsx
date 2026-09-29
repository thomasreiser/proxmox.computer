import { describe, expect, it } from "vitest";
import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { router } from "@/test/router";
import { buildAnswerToml } from "./setup/answer-file";
import { STORAGE_KEY, loadPersistedState } from "./setup/wizard-state";
import { persistedState } from "./setup/test-fixtures";
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

describe("adjusting a setup from its answer file", () => {
  const ctx = { hostnameSuffix: "lab.lan", gateway: "10.0.10.1", dns: "10.0.10.1", timezone: "UTC", locale: "en-US" };
  const answerFile = (state = persistedState({ currentStep: "backups", hostnameSuffix: "lab.lan" })) =>
    new File([buildAnswerToml(state.nodes[0], ctx, state)], "answer-pve01.toml", { type: "application/toml" });
  const picker = () => screen.getByLabelText(/adjust a setup from its \.toml/i);

  it("offers it beside starting the setup", () => {
    render(<Home />);
    expect(picker()).toHaveAttribute("type", "file");
    expect(picker()).toHaveAttribute("accept", ".toml,application/toml");
  });

  // the stepper only moves forward, so a reopened setup starts at step 1
  it("opens the setup from the file, at step 1", async () => {
    const user = userEvent.setup();
    render(<Home />);
    await user.upload(picker(), answerFile());
    expect(router.push).toHaveBeenCalledWith("/setup");
    const saved = loadPersistedState();
    expect(saved?.currentStep).toBe("hardware");
    expect(saved?.hostnameSuffix).toBe("lab.lan");
  });

  it("asks before replacing a setup already saved here", async () => {
    window.localStorage.setItem(STORAGE_KEY, JSON.stringify(persistedState({ hostnameSuffix: "mine.lan" })));
    const user = userEvent.setup();
    render(<Home />);
    await user.upload(picker(), answerFile());
    expect(router.push).not.toHaveBeenCalled();
    expect(await screen.findByRole("alertdialog")).toHaveTextContent(/already has a setup saved/i);

    await user.click(screen.getByRole("button", { name: /keep the saved one/i }));
    expect(screen.queryByRole("alertdialog")).not.toBeInTheDocument();
    expect(loadPersistedState()?.hostnameSuffix).toBe("mine.lan");

    await user.upload(picker(), answerFile());
    await user.click(await screen.findByRole("button", { name: /replace it/i }));
    expect(router.push).toHaveBeenCalledWith("/setup");
    expect(loadPersistedState()?.hostnameSuffix).toBe("lab.lan");
  });

  it("explains a file it can't reopen, and saves nothing", async () => {
    const user = userEvent.setup();
    render(<Home />);
    await user.upload(picker(), new File(['[global]\nfqdn = "pve.example"\n'], "answer.toml"));
    expect(await screen.findByRole("alert")).toHaveTextContent(/no proxmox\.computer setup in it/i);
    expect(router.push).not.toHaveBeenCalled();
    expect(loadPersistedState()).toBeNull();
  });
});
