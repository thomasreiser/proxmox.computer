"use client";

import Link from "next/link";
import { useEffect, useState, type ReactNode } from "react";
import {
  WrongPassphraseError,
  clearStored,
  cryptoAvailable,
  isUnlocked,
  startSession,
  storedEnvelope,
  unlockStored,
  validateNewPassphrase,
} from "./vault";

type Phase = "checking" | "open" | "unlock" | "create" | "insecure";

/**
 * Stands in front of anything that reads the saved setup. The wizard needs
 * a key to save at all, so with nothing saved it asks for a new passphrase;
 * a preview with nothing saved just opens (and says so itself). Whatever's
 * saved is only ever unlocked here — the key never leaves memory.
 */
export function VaultGate({ mode, children }: { mode: "wizard" | "preview"; children: ReactNode }) {
  const [phase, setPhase] = useState<Phase>("checking");

  // localStorage is only read after mount, like every other read of it
  /* eslint-disable react-hooks/set-state-in-effect */
  useEffect(() => {
    if (isUnlocked()) setPhase("open");
    else if (!cryptoAvailable()) setPhase("insecure");
    else if (storedEnvelope()) setPhase("unlock");
    else setPhase(mode === "wizard" ? "create" : "open");
  }, [mode]);
  /* eslint-enable react-hooks/set-state-in-effect */

  if (phase === "open") return <>{children}</>;
  if (phase === "checking") return null;
  return (
    <div className="pc-root flex min-h-full flex-col">
      <header className="border-b border-border">
        <div className="mx-auto flex max-w-6xl items-center justify-between px-6 py-5">
          <Link href="/" className="flex items-center gap-2.5">
            <span className="code flex h-7 w-7 items-center justify-center bg-accent font-bold text-on-accent">{">"}</span>
            <span className="text-[15px] font-semibold tracking-tight">
              proxmox<span className="text-accent">.computer</span>
            </span>
          </Link>
        </div>
      </header>
      <main className="flex-1 px-6 py-12">
        <div className="mx-auto max-w-xl">
          {phase === "insecure" ? (
            <InsecureNotice />
          ) : phase === "create" ? (
            <CreateForm onDone={() => setPhase("open")} />
          ) : (
            <UnlockForm onDone={() => setPhase("open")} onStartOver={() => setPhase(mode === "wizard" ? "create" : "open")} />
          )}
        </div>
      </main>
    </div>
  );
}

/** without WebCrypto nothing can be sealed, so nothing may be typed in either */
function InsecureNotice() {
  return (
    <div className="pc-stepflow__card">
      <p className="meta pc-stepflow__meta"># not a secure page</p>
      <h2 className="h2 pc-stepflow__title">this page needs https</h2>
      <p className="body pc-stepflow__intro">
        Your setup is encrypted in this browser before it&apos;s saved, and
        browsers only allow that encryption on a secure page: https, or
        localhost. This copy was opened over plain http, so it can&apos;t
        keep root passwords safe — open it over https instead.
      </p>
      <div className="pc-stepflow__nav">
        <Link href="/" className="pc-btn pc-btn--ghost">
          ← back
        </Link>
      </div>
    </div>
  );
}

function PassphraseField({
  id,
  label,
  value,
  onChange,
  autoComplete,
}: {
  id: string;
  label: string;
  value: string;
  onChange: (value: string) => void;
  autoComplete: string;
}) {
  return (
    <div className="pc-field">
      <label className="label pc-field__label" htmlFor={id}>
        {label}
      </label>
      <div className="pc-field__control">
        <span className="code pc-field__bracket">*</span>
        <input
          id={id}
          className="pc-field__input code"
          type="password"
          autoComplete={autoComplete}
          value={value}
          onChange={(e) => onChange(e.target.value)}
        />
      </div>
    </div>
  );
}

function CreateForm({ onDone }: { onDone: () => void }) {
  const [passphrase, setPassphrase] = useState("");
  const [confirm, setConfirm] = useState("");
  const [tried, setTried] = useState(false);
  const [busy, setBusy] = useState(false);
  const error = validateNewPassphrase(passphrase, confirm);

  async function submit() {
    setTried(true);
    if (error) return;
    setBusy(true);
    await startSession(passphrase);
    onDone();
  }

  return (
    <form
      className="pc-stepflow__card"
      onSubmit={(e) => {
        e.preventDefault();
        void submit();
      }}
    >
      <p className="meta pc-stepflow__meta"># before you start</p>
      <h2 className="h2 pc-stepflow__title">choose a passphrase</h2>
      <p className="body pc-stepflow__intro">
        The setup you build here ends up holding root passwords, so it&apos;s
        encrypted before it&apos;s saved in this browser — and in every answer
        file you download. This passphrase is the key. It never leaves this
        page, and there&apos;s no way to recover it: keep it in your password
        manager.
      </p>
      <div className="pc-stepflow__fields">
        <PassphraseField id="passphrase" label="passphrase" value={passphrase} onChange={setPassphrase} autoComplete="new-password" />
        <PassphraseField id="passphrase-confirm" label="once more" value={confirm} onChange={setConfirm} autoComplete="new-password" />
        {tried && error && (
          <p className="body-sm pc-field__hint" role="alert" style={{ color: "var(--danger)" }}>
            {error}
          </p>
        )}
      </div>
      <div className="pc-stepflow__nav">
        <Link href="/" className="pc-btn pc-btn--ghost">
          ← back
        </Link>
        <button type="submit" className="pc-btn pc-btn--primary" disabled={busy}>
          <span className="pc-btn__bracket">[</span>
          {busy ? "deriving the key…" : "start"}
          <span className="pc-btn__bracket">]</span>
        </button>
      </div>
    </form>
  );
}

function UnlockForm({ onDone, onStartOver }: { onDone: () => void; onStartOver: () => void }) {
  const [passphrase, setPassphrase] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [confirmingReset, setConfirmingReset] = useState(false);

  async function submit() {
    setError(null);
    setBusy(true);
    try {
      await unlockStored(passphrase);
      onDone();
    } catch (e) {
      setError(e instanceof WrongPassphraseError ? "that's not the passphrase this setup was saved with" : "the saved setup couldn't be read");
      setBusy(false);
    }
  }

  return (
    <form
      className="pc-stepflow__card"
      onSubmit={(e) => {
        e.preventDefault();
        void submit();
      }}
    >
      <p className="meta pc-stepflow__meta"># locked</p>
      <h2 className="h2 pc-stepflow__title">unlock your setup</h2>
      <p className="body pc-stepflow__intro">
        This browser has a setup saved, encrypted with the passphrase you chose
        when you started it.
      </p>
      <div className="pc-stepflow__fields">
        <PassphraseField id="unlock-passphrase" label="passphrase" value={passphrase} onChange={setPassphrase} autoComplete="current-password" />
        {error && (
          <p className="body-sm pc-field__hint" role="alert" style={{ color: "var(--danger)" }}>
            {error}
          </p>
        )}
        {confirmingReset && (
          <div className="pc-callout pc-callout--danger" role="alertdialog" aria-label="delete the saved setup?">
            <span className="code pc-callout__glyph">✗</span>
            <div className="pc-callout__body">
              <p className="body-sm pc-callout__text">
                without the passphrase the saved setup can&apos;t be read by anyone. starting over deletes it for good.
              </p>
              <div className="mt-3 flex flex-wrap gap-3">
                <button
                  type="button"
                  className="pc-btn pc-btn--primary"
                  onClick={() => {
                    clearStored();
                    onStartOver();
                  }}
                >
                  <span className="pc-btn__bracket">[</span>
                  delete it and start over
                  <span className="pc-btn__bracket">]</span>
                </button>
                <button type="button" className="pc-btn pc-btn--ghost" onClick={() => setConfirmingReset(false)}>
                  keep it
                </button>
              </div>
            </div>
          </div>
        )}
      </div>
      <div className="pc-stepflow__nav">
        <button type="button" className="pc-btn pc-btn--ghost" onClick={() => setConfirmingReset(true)}>
          forgot it? start over
        </button>
        <button type="submit" className="pc-btn pc-btn--primary" disabled={busy || !passphrase}>
          <span className="pc-btn__bracket">[</span>
          {busy ? "unlocking…" : "unlock"}
          <span className="pc-btn__bracket">]</span>
        </button>
      </div>
    </form>
  );
}
