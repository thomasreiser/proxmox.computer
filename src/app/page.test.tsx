import { describe, expect, it } from "vitest";
import { render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { router } from "@/test/router";
import { prepareAnswerFiles } from "./setup/answer-file";
import { STEP_VERSIONS, STORAGE_KEY } from "./setup/wizard-state";
import { loadPersistedState, savePersistedState } from "./setup/saved-state";
import { isUnlocked, lock, startSession, unlockStored } from "./setup/vault";
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
  /** an answer file whose setup is sealed with "file passphrase" */
  async function answerFile(state = persistedState({ currentStep: "backups", hostnameSuffix: "lab.lan" })) {
    await startSession("file passphrase");
    const [first] = await prepareAnswerFiles(state);
    return new File([first.toml], "answer-pve01.toml", { type: "application/toml" });
  }
  const picker = () => screen.getByLabelText(/adjust a setup from its \.toml/i);

  async function enterPassphrase(user: ReturnType<typeof userEvent.setup>, passphrase = "file passphrase") {
    await user.type(await screen.findByLabelText(/^passphrase/i), passphrase);
    await user.click(screen.getByRole("button", { name: /open it/i }));
  }

  it("offers it beside starting the setup", () => {
    render(<Home />);
    expect(picker()).toHaveAttribute("type", "file");
    expect(picker()).toHaveAttribute("accept", ".toml,application/toml");
  });

  // the stepper only moves forward, so a reopened setup starts at step 1
  it("opens the setup with the file's passphrase, at step 2", async () => {
    const file = await answerFile();
    lock(); // a fresh visit: nothing unlocked yet
    const user = userEvent.setup();
    render(<Home />);
    await user.upload(picker(), file);
    await enterPassphrase(user);
    await waitFor(() => expect(router.push).toHaveBeenCalledWith("/setup"));
    const saved = await loadPersistedState();
    expect(saved?.currentStep).toBe("location");
    expect(saved?.hostnameSuffix).toBe("lab.lan");
  });

  it("refuses the wrong passphrase, and saves nothing", async () => {
    const file = await answerFile();
    lock();
    const user = userEvent.setup();
    render(<Home />);
    await user.upload(picker(), file);
    await enterPassphrase(user, "a wrong passphrase");
    expect(await screen.findByRole("alert")).toHaveTextContent(/not the passphrase/i);
    expect(router.push).not.toHaveBeenCalled();
    expect(window.localStorage.getItem(STORAGE_KEY)).toBeNull();
  });

  it("asks before replacing a setup already saved here", async () => {
    const file = await answerFile();
    // this browser's own setup, under its own passphrase — then a reload
    await startSession("browser passphrase");
    await savePersistedState(persistedState({ hostnameSuffix: "mine.lan" }));
    lock();

    const user = userEvent.setup();
    render(<Home />);
    await user.upload(picker(), file);
    await enterPassphrase(user);
    expect(await screen.findByRole("alertdialog")).toHaveTextContent(/already has a setup saved/i);
    expect(router.push).not.toHaveBeenCalled();

    await user.click(screen.getByRole("button", { name: /keep the saved one/i }));
    expect(screen.queryByRole("alertdialog")).not.toBeInTheDocument();
    // kept, and still under its own passphrase
    expect(isUnlocked()).toBe(false);
    expect(await unlockStored("browser passphrase")).toMatchObject({ hostnameSuffix: "mine.lan" });
    lock();

    await user.upload(picker(), file);
    await enterPassphrase(user);
    await user.click(await screen.findByRole("button", { name: /replace it/i }));
    await waitFor(() => expect(router.push).toHaveBeenCalledWith("/setup"));
    // replaced — and from now on it opens with the file's passphrase
    expect((await loadPersistedState())?.hostnameSuffix).toBe("lab.lan");
    lock();
    expect(await unlockStored("file passphrase")).toMatchObject({ hostnameSuffix: "lab.lan" });
  });

  // a file from before this build changed step 5: steps 1–4 come back
  it("says which steps start over before opening an older file", async () => {
    const base = persistedState({ currentStep: "backups", hostnameSuffix: "lab.lan" });
    const file = await answerFile({ ...base, stepVersions: { ...base.stepVersions, backups: base.stepVersions.backups - 1 } });
    lock();
    const user = userEvent.setup();
    render(<Home />);
    await user.upload(picker(), file);
    await enterPassphrase(user);
    const dialog = await screen.findByRole("alertdialog", { name: "open the setup?" });
    expect(dialog).toHaveTextContent(/step 5, backups, has changed .* steps 1–4 are kept/);
    expect(dialog).not.toHaveTextContent(/already has a setup saved/);
    expect(router.push).not.toHaveBeenCalled();

    await user.click(within(dialog).getByRole("button", { name: /open it/i }));
    await waitFor(() => expect(router.push).toHaveBeenCalledWith("/setup"));
    const saved = await loadPersistedState();
    expect(saved?.hostnameSuffix).toBe("lab.lan");
    expect(saved?.stepVersions).toEqual(STEP_VERSIONS);
  });

  it("explains a file it can't reopen, and saves nothing", async () => {
    const user = userEvent.setup();
    render(<Home />);
    await user.upload(picker(), new File(['[global]\nfqdn = "pve.example"\n'], "answer.toml"));
    expect(await screen.findByRole("alert")).toHaveTextContent(/no proxmox\.computer setup in it/i);
    expect(screen.queryByLabelText(/^passphrase/i)).not.toBeInTheDocument();
    expect(router.push).not.toHaveBeenCalled();
    expect(window.localStorage.getItem(STORAGE_KEY)).toBeNull();
  });
});
