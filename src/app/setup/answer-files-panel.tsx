"use client";

import { useEffect, useState } from "react";
import { prepareAnswerFiles, tomlDataUrl, type PreparedAnswerFile } from "./answer-file";
import type { PersistedState } from "./wizard-state";

/**
 * Step 8's downloads: one answer.toml per node, each a data: link — no
 * server, nothing leaves the browser. Built once the setup is complete:
 * hashing every root password and sealing the setup both take a moment.
 */
export function AnswerFilesPanel({ state, blocked }: { state: PersistedState; blocked: boolean }) {
  const [files, setFiles] = useState<PreparedAnswerFile[] | null>(null);

  useEffect(() => {
    if (blocked) return;
    let cancelled = false;
    void prepareAnswerFiles(state).then((prepared) => {
      if (!cancelled) setFiles(prepared);
    });
    return () => {
      cancelled = true;
    };
  }, [state, blocked]);

  return (
    <section className="flex flex-col" style={{ gap: "var(--space-3)" }} aria-label="answer files">
      <p className="label text-ink-muted">answer files — one per node</p>
      <p className="body-sm text-ink-muted">
        Root passwords are in there only as hashes, and the setup each file
        carries is encrypted with your passphrase: to change anything later,
        pick &quot;adjust a setup&quot; on the start page and hand it any one
        of them.
      </p>
      {blocked && <p className="body-sm pc-field__hint">fix the problems listed at the top of this step first</p>}
      {!blocked && !files && <p className="body-sm pc-field__hint">hashing passwords and encrypting the setup…</p>}
      {!blocked && files && (
        <div className="flex flex-wrap" style={{ gap: "var(--space-2)" }}>
          {files.map((file) => (
            <a key={file.fileName} className="pc-btn" href={tomlDataUrl(file.toml)} download={file.fileName}>
              <span className="pc-btn__bracket">[</span>
              {file.fileName}
              <span className="pc-btn__bracket">]</span>
            </a>
          ))}
        </div>
      )}
    </section>
  );
}
