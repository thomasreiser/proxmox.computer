"use client";

import { useEffect, useState } from "react";
import { DISK_PLACEHOLDER, prepareAnswerFiles, tomlDataUrl, type PreparedAnswerFile } from "./answer-file";
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
    <section className="flex flex-col border border-border bg-surface-100 p-5" style={{ gap: "var(--space-3)" }}>
      <p className="label text-ink-muted">answer files — one per node</p>
      <p className="body-sm text-ink-muted">
        Bake each node&apos;s <span className="code">answer.toml</span> into the
        proxmox iso and boot it: the node installs itself, reachable at the
        address from step 3, with your key and its root password.
      </p>
      <p className="body-sm text-ink-muted">
        Before you build an iso, open its file and replace{" "}
        <span className="code">{DISK_PLACEHOLDER}</span> with the boot disk —
        the wizard never names a device, and the installer wipes whatever it
        points at, so until you change it the install stops instead of
        guessing. Root passwords are in there only as hashes, and the setup
        each file carries is encrypted with your passphrase: to change
        anything later, pick &quot;adjust a setup&quot; on the start page and
        hand it any one of them.
      </p>
      {blocked && <p className="body-sm pc-field__hint">fix the problems listed below first</p>}
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
