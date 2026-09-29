"use client";

import { useState } from "react";
import { useRouter } from "next/navigation";
import { readAnswerToml } from "./setup/answer-file";
import { loadPersistedState, replacePersistedState, type PersistedState } from "./setup/wizard-state";

// Reopens a setup from one of its answer files (see stateBlock). The file
// is read here, in the browser — nothing is uploaded anywhere. A setup
// already saved in this browser is only replaced after the visitor says so.
export function OpenSetupButton() {
  const router = useRouter();
  const [pending, setPending] = useState<PersistedState | null>(null);
  const [error, setError] = useState<string | null>(null);

  function open(state: PersistedState) {
    // back to step 1: the stepper only moves forward through previews, so
    // starting at the top lets the visitor adjust any step on the way
    if (!replacePersistedState({ ...state, currentStep: "hardware" })) {
      setError("this browser won't let the site save anything (private mode?), so the setup can't be opened here.");
      return;
    }
    router.push("/setup");
  }

  async function onFile(file: File) {
    setError(null);
    setPending(null);
    const result = readAnswerToml(await file.text());
    if ("error" in result) {
      setError(result.error);
      return;
    }
    if (loadPersistedState()) setPending(result.state);
    else open(result.state);
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

      {pending && (
        <div className="pc-callout pc-callout--warning basis-full" role="alertdialog" aria-label="replace the saved setup?">
          <span className="code pc-callout__glyph">!</span>
          <div className="pc-callout__body">
            <p className="body-sm pc-callout__text">
              this browser already has a setup saved. opening{" "}
              {pending.nodes.map((n) => n.network.hostLabel || n.name).join(", ")} replaces it.
            </p>
            <div className="mt-3 flex flex-wrap gap-3">
              <button type="button" className="pc-btn pc-btn--primary" onClick={() => open(pending)}>
                <span className="pc-btn__bracket">[</span>
                replace it
                <span className="pc-btn__bracket">]</span>
              </button>
              <button type="button" className="pc-btn pc-btn--ghost" onClick={() => setPending(null)}>
                keep the saved one
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
