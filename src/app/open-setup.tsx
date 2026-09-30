"use client";

import { useState } from "react";
import { useRouter } from "next/navigation";
import { openAnswerSetup, readAnswerToml } from "./setup/answer-file";
import { adopt, storedEnvelope, type Envelope, type Opened } from "./setup/vault";
import type { PersistedState, SavedStepId } from "./setup/wizard-state";
import { savePersistedState, startedOverNotice } from "./setup/saved-state";

type Stage =
  | { kind: "idle" }
  | { kind: "passphrase"; envelope: Envelope }
  // replaces: a setup is already saved here
  | { kind: "confirm"; state: PersistedState; opened: Opened; startedOverFrom: SavedStepId | null; replaces: boolean };

// Reopens a setup from one of its answer files (see stateBlock). The file
// is read here, in the browser — nothing is uploaded anywhere. Its setup is
// sealed, so it asks for the passphrase it was saved with; a setup already
// saved in this browser is only replaced after the visitor says so.
export function OpenSetupButton() {
  const router = useRouter();
  const [stage, setStage] = useState<Stage>({ kind: "idle" });
  const [passphrase, setPassphrase] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function openWith(state: PersistedState, opened: Opened) {
    // from here on the wizard works under this file's passphrase
    adopt(opened);
    // back to step 1: the stepper only moves forward through previews, so
    // starting at the top lets the visitor adjust any step on the way
    if (!(await savePersistedState({ ...state, currentStep: "location" }))) {
      setError("this browser won't let the site save anything (private mode?), so the setup can't be opened here.");
      return;
    }
    router.push("/setup");
  }

  async function onFile(file: File) {
    setError(null);
    setPassphrase("");
    const result = readAnswerToml(await file.text());
    if ("error" in result) {
      setStage({ kind: "idle" });
      setError(result.error);
      return;
    }
    setStage({ kind: "passphrase", envelope: result.envelope });
  }

  async function unlock(envelope: Envelope) {
    setError(null);
    setBusy(true);
    const result = await openAnswerSetup(envelope, passphrase);
    setBusy(false);
    if ("error" in result) {
      setError(result.error);
      return;
    }
    // a setup already here, or one this build could only keep in part, is
    // opened once the visitor has seen what that means
    const replaces = !!storedEnvelope();
    if (replaces || result.startedOverFrom) {
      setStage({ kind: "confirm", state: result.state, opened: result.opened, startedOverFrom: result.startedOverFrom, replaces });
    } else await openWith(result.state, result.opened);
  }

  return (
    <>
      <label className="pc-btn pc-btn--file">
        <span className="pc-btn__bracket">[</span>
        adjust a setup from its .toml
        <span className="pc-btn__bracket">]</span>
        <input
          type="file"
          accept=".toml,application/toml"
          className="sr-only"
          onChange={(e) => {
            const file = e.target.files?.[0];
            // cleared, so picking the same file again still fires
            e.target.value = "";
            if (file) void onFile(file);
          }}
        />
      </label>

      {stage.kind === "passphrase" && (
        <form
          className="pc-callout pc-callout--info basis-full"
          onSubmit={(e) => {
            e.preventDefault();
            void unlock(stage.envelope);
          }}
        >
          <span className="code pc-callout__glyph">*</span>
          <div className="pc-callout__body">
            <p className="body-sm pc-callout__text">
              this file&apos;s setup is encrypted — enter the passphrase it was saved with.
            </p>
            <div className="pc-field mt-3">
              <label className="label pc-field__label" htmlFor="file-passphrase">
                passphrase
              </label>
              <div className="pc-field__control">
                <input
                  id="file-passphrase"
                  className="pc-field__input code"
                  type="password"
                  autoComplete="current-password"
                  value={passphrase}
                  onChange={(e) => setPassphrase(e.target.value)}
                />
              </div>
            </div>
            <div className="mt-3 flex flex-wrap gap-3">
              <button type="submit" className="pc-btn pc-btn--primary" disabled={busy || !passphrase}>
                <span className="pc-btn__bracket">[</span>
                {busy ? "unlocking…" : "open it"}
                <span className="pc-btn__bracket">]</span>
              </button>
              <button type="button" className="pc-btn pc-btn--ghost" onClick={() => setStage({ kind: "idle" })}>
                cancel
              </button>
            </div>
          </div>
        </form>
      )}

      {stage.kind === "confirm" && (
        <div
          className="pc-callout pc-callout--warning basis-full"
          role="alertdialog"
          aria-label={stage.replaces ? "replace the saved setup?" : "open the setup?"}
        >
          <span className="code pc-callout__glyph">!</span>
          <div className="pc-callout__body">
            {stage.startedOverFrom && (
              <p className="body-sm pc-callout__text">{startedOverNotice(stage.startedOverFrom)}</p>
            )}
            {stage.replaces && (
              <p className="body-sm pc-callout__text">
                this browser already has a setup saved. opening{" "}
                {stage.state.nodes.map((n) => n.network.hostLabel || n.name).join(", ")} replaces it — and from then on
                it opens with this file&apos;s passphrase.
              </p>
            )}
            <div className="mt-3 flex flex-wrap gap-3">
              <button type="button" className="pc-btn pc-btn--primary" onClick={() => void openWith(stage.state, stage.opened)}>
                <span className="pc-btn__bracket">[</span>
                {stage.replaces ? "replace it" : "open it"}
                <span className="pc-btn__bracket">]</span>
              </button>
              <button type="button" className="pc-btn pc-btn--ghost" onClick={() => setStage({ kind: "idle" })}>
                {stage.replaces ? "keep the saved one" : "cancel"}
              </button>
            </div>
          </div>
        </div>
      )}

      {error && (
        <div className="pc-callout pc-callout--danger basis-full" role="alert">
          <span className="code pc-callout__glyph">✗</span>
          <div className="pc-callout__body">
            <p className="body-sm pc-callout__text">{error}</p>
          </div>
        </div>
      )}
    </>
  );
}
