"use client";

import Link from "next/link";
import { useEffect, useMemo, useState } from "react";
import { useRouter } from "next/navigation";
import { type PersistedState } from "../../wizard-state";
import { loadPersistedState, persistCurrentStep } from "../../saved-state";
import { VaultGate } from "../../vault-gate";
import { problemsUpTo } from "../../step-checks";
import { ProblemList } from "../../problem-list";
import {
  USERNAME_CLAIM_OPTIONS,
  oidcRedirectUris,
  parseSshPublicKey,
  rootPasswordFor,
  sshFingerprint,
  sshKeyLines,
  type SshPublicKey,
} from "../../access";
import { nodeFqdn } from "../../answer-file";

export default function AccessPreview() {
  return (
    <VaultGate mode="preview">
      <AccessPreviewPage />
    </VaultGate>
  );
}

function Section({ title, children }: { title: string; children: React.ReactNode }) {
  return (
    <section className="flex flex-col border border-border bg-surface-100 p-5" style={{ gap: "var(--space-3)" }}>
      <p className="label text-ink-muted">{title}</p>
      {children}
    </section>
  );
}

function AccessPreviewPage() {
  const router = useRouter();
  const [saved, setSaved] = useState<PersistedState | null>(null);
  const [hydrated, setHydrated] = useState(false);
  const [fingerprints, setFingerprints] = useState<string[]>([]);

  useEffect(() => {
    void loadPersistedState().then((state) => {
      setSaved(state);
      setHydrated(true);
    });
  }, []);

  const keys = useMemo(
    () =>
      saved
        ? sshKeyLines(saved.access.sshKeys)
            .map(parseSshPublicKey)
            .filter((k): k is SshPublicKey => k !== null)
        : [],
    [saved],
  );
  const blocking = useMemo(() => (saved ? problemsUpTo("access", saved) : []), [saved]);

  useEffect(() => {
    let cancelled = false;
    void Promise.all(keys.map(sshFingerprint)).then((prints) => {
      if (!cancelled) setFingerprints(prints);
    });
    return () => {
      cancelled = true;
    };
  }, [keys]);

  function goToSoftware() {
    if (blocking.length > 0) return;
    void persistCurrentStep("software").then(() => router.push("/setup"));
  }

  const oidc = saved?.access.oidc;

  return (
    <div className="pc-root flex min-h-full flex-col">
      <header className="border-b border-border">
        <div className="mx-auto flex max-w-6xl items-center justify-between px-6 py-5">
          <Link href="/" className="flex items-center gap-2.5">
            <span className="code flex h-7 w-7 items-center justify-center bg-accent font-bold text-on-accent">
              {">"}
            </span>
            <span className="text-[15px] font-semibold tracking-tight">
              proxmox<span className="text-accent">.computer</span>
            </span>
          </Link>
          <Link href="/setup" className="meta text-ink-muted transition-colors hover:text-ink">
            ← back to setup
          </Link>
        </div>
      </header>

      <main className="flex-1 px-6 py-12">
        {/* nothing until the saved setup is decrypted — no flash of an empty preview */}
        {hydrated && (
          <div className="mx-auto flex max-w-6xl flex-col" style={{ gap: "var(--space-5)" }}>
            <div>
              <p className="meta pc-stepflow__meta"># step 6 of 8 — preview</p>
              <h2 className="h2 pc-stepflow__title">access</h2>
              <p className="body pc-stepflow__intro">
                Who gets in, and how. Passwords are never shown here — only
                whether each node has one.
              </p>
            </div>

            {hydrated && !saved && (
              <div className="pc-canvas__empty">
                <p className="body text-ink-muted">nothing saved to preview yet.</p>
                <Link href="/setup" className="pc-btn pc-btn--primary">
                  <span className="pc-btn__bracket">[</span>
                  start at step 1
                  <span className="pc-btn__bracket">]</span>
                </Link>
              </div>
            )}

            {hydrated && saved && oidc && (
              <>
                <div className="pc-summary">
                  <div className="pc-summary__cell">
                    <span className="label pc-summary__key">nodes</span>
                    <span className="code pc-summary__val">{saved.nodes.length}</span>
                  </div>
                  <div className="pc-summary__cell">
                    <span className="label pc-summary__key">ssh keys</span>
                    <span className="code pc-summary__val">{keys.length || "—"}</span>
                  </div>
                  <div className="pc-summary__cell">
                    <span className="label pc-summary__key">ssh passwords</span>
                    <span className="code pc-summary__val pc-summary__val--sm">
                      {saved.access.disablePasswordSsh ? "off" : "on"}
                    </span>
                  </div>
                  <div className="pc-summary__cell">
                    <span className="label pc-summary__key">oidc</span>
                    <span className="code pc-summary__val pc-summary__val--sm">{oidc.enabled ? oidc.realm : "off"}</span>
                  </div>
                </div>

                <Section title="ssh keys — root on every node">
                  {keys.length === 0 ? (
                    <p className="body-sm pc-field__hint">none yet</p>
                  ) : (
                    <ul className="pc-keylist">
                      {keys.map((key, i) => (
                        <li key={key.data} className="body-sm pc-access__row">
                          <span className="code">{key.type}</span>
                          <span className="text-ink-muted">{key.comment || "(no comment)"}</span>
                          <span className="code pc-access__dim">{fingerprints[i] ?? "…"}</span>
                        </li>
                      ))}
                    </ul>
                  )}
                  <p className="body-sm text-ink-muted">
                    {saved.access.disablePasswordSsh
                      ? "ssh takes these keys only — passwords work in the web ui and at the console."
                      : "ssh takes these keys and root's password."}{" "}
                    the installer adds the keys; the ssh setting is applied when the cluster is configured.
                  </p>
                </Section>

                <Section title="root passwords">
                  <ul className="pc-keylist">
                    {saved.nodes.map((node, i) => {
                      const set = rootPasswordFor(saved.access, i).length > 0;
                      return (
                        <li key={i} className="body-sm pc-access__row">
                          <span className="code">{nodeFqdn(node, saved.hostnameSuffix)}</span>
                          <span className={set ? "pc-access__ok" : "pc-access__missing"}>{set ? "✓ set" : "✗ not set"}</span>
                        </li>
                      );
                    })}
                  </ul>
                </Section>

                {oidc.enabled && (
                  <Section title={`oidc — realm ${oidc.realm}`}>
                    <div className="pc-summary">
                      <div className="pc-summary__cell">
                        <span className="label pc-summary__key">issuer</span>
                        <span className="code pc-summary__val pc-summary__val--sm">{oidc.issuerUrl || "—"}</span>
                      </div>
                      <div className="pc-summary__cell">
                        <span className="label pc-summary__key">client</span>
                        <span className="code pc-summary__val pc-summary__val--sm">
                          {oidc.clientId || "—"} {oidc.clientSecret ? "(with secret)" : "(public)"}
                        </span>
                      </div>
                      <div className="pc-summary__cell">
                        <span className="label pc-summary__key">user name from</span>
                        <span className="code pc-summary__val pc-summary__val--sm">
                          {USERNAME_CLAIM_OPTIONS.find((o) => o.value === oidc.usernameClaim)?.label}
                        </span>
                      </div>
                    </div>
                    <p className="body-sm text-ink-muted">
                      {oidc.autocreate ? "users are created on first login, with no permissions" : "users must exist before they can log in"}
                      {oidc.isDefault ? " — preselected on the login screen" : ""}. set up when the cluster is
                      configured. register these redirect uris with the client:
                    </p>
                    <ul className="pc-urilist">
                      {oidcRedirectUris(saved.nodes, saved.hostnameSuffix).map((uri) => (
                        <li key={uri} className="code body-sm">
                          {uri}
                        </li>
                      ))}
                    </ul>
                  </Section>
                )}

              </>
            )}

            {hydrated && saved && <ProblemList problems={blocking} step="access" />}
            <div className="pc-stepflow__nav">
              <Link href="/setup" className="pc-btn pc-btn--ghost">
                ← back to access
              </Link>
              <button
                type="button"
                className="pc-btn pc-btn--primary"
                onClick={goToSoftware}
                disabled={blocking.length > 0}
                title={blocking.length > 0 ? "fix the problems listed above first" : undefined}
              >
                <span className="pc-btn__bracket">[</span>
                next
                <span className="pc-btn__bracket">]</span>
              </button>
            </div>
          </div>
        )}
      </main>
    </div>
  );
}
